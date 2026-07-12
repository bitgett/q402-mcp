/**
 * Server-side Q402 client - Node.js variant of public/q402-sdk.js.
 *
 * The browser SDK relies on `window.ethereum` for signing. Here we sign with
 * an `ethers.Wallet` loaded from `Q402_PRIVATE_KEY`, then post the same body
 * shape to /api/relay. EIP-712 domains, witness types, and the EIP-7702
 * authorization tuple match the browser SDK exactly so the same on-chain
 * implementation contracts accept relays from either path.
 */

import {
  JsonRpcProvider,
  Wallet,
  hexlify,
  parseUnits,
  randomBytes,
  toBigInt,
} from "ethers";
import type { ChainConfig } from "./chains.js";
import { tokenFor } from "./chains.js";

export interface PayResult {
  /**
   * Was a real on-chain transaction broadcast and settled? Strictly `true`
   * only when funds actually moved. Sandbox responses now return `false`
   * here so a downstream chatbot summary that lifts just this field doesn't
   * tell the user "payment succeeded" when nothing happened.
   *
   * Earlier versions set `success: true` even for sandbox + carried the
   * disclosure on the wrapping PaySummary's `setupHint`. The README warned
   * about that risk, but if a model strips the wrapper before showing the
   * result the warning was lost. Splitting `success` (did funds move?) from
   * `sandbox` (was this a simulation?) makes the safe interpretation
   * survive any reasonable summarization pass.
   */
  success: boolean;
  /**
   * Explicit sandbox marker. `true` on every simulated response, regardless
   * of method. AI clients should branch on this before showing the user a
   * confirmation message. Stays `false` (or undefined) on real settlements.
   */
  sandbox?: boolean;
  txHash: string;
  blockNumber?: string;
  tokenAmount: string;
  token: "USDC" | "USDT" | "RLUSD" | "Q" | "USDG";
  chain: string;
  method: string;
  /** Set on sandbox / simulated responses so the agent can disclose mode. */
  mode?: "sandbox" | "live";
  explorerUrl?: string | null;
  /**
   * Mode C only - `true` when an identical send is still in flight on
   * the server (concurrent retry hit the SET NX idempotency claim).
   * The caller should wait `retryAfterSec` and retry the same call;
   * the server will return the cached settlement once the original
   * completes. Distinct from `success: false + error` (which means
   * the server actually said no).
   */
  pending?: boolean;
  retryAfterSec?: number;
  /**
   * Mode C MultiPayeeSplit only - `true` when the server fanned the
   * payment out to N legs instead of a single recipient. When set, the
   * funds went to the addresses in `legs` (NOT the top-level `to`), and
   * the top-level `txHash` mirrors the first settled leg's hash. The AI
   * should report the per-leg breakdown, not just the top-level hash.
   */
  split?: boolean;
  /**
   * Per-leg settlement results for a split. Each leg is its own on-chain
   * transfer: settled legs carry a `txHash`, failed legs carry an `error`.
   */
  legs?: Array<{ recipient: string; amount: string; txHash?: string; error?: string }>;
  /** Number of legs that settled on-chain (split only). */
  settledLegs?: number;
  /** Number of legs that failed (split only). Non-zero with success:true is impossible. */
  failedLegs?: number;
  /**
   * Split only - `true` when NOT every leg settled (server HTTP 207 /
   * status==='partial'). Funds DID move for the settled legs; this is NOT
   * a plain failure and the AI must NOT tell the user to blindly "retry"
   * (a retry would replay only the still-pending intent, never double-pay
   * the legs that already landed). Inspect `legs[]` to see which landed.
   */
  partial?: boolean;
  /**
   * Mode C only - `true` when the server returned a cached settlement for
   * a duplicate request (durable replay guard) rather than firing a fresh
   * one. Outcome is identical to the original; surfaced so the AI can say
   * "already settled earlier" instead of implying a second payment.
   */
  replayed?: boolean;
}

export interface PayInput {
  to: string;
  amount: string;
  token: "USDC" | "USDT" | "RLUSD" | "Q" | "USDG";
}

export interface ClientOptions {
  apiKey: string;
  privateKey: string;
  chain: ChainConfig;
  relayBaseUrl: string;
  /** Optional: override RPC for fetching the EOA's transaction count. */
  rpcUrl?: string;
}

// Mirrors CHAIN_RPC_FALLBACKS[*][0] in q402-landing/app/lib/relayer.ts so the
// MCP client and the production relayer agree on RPC defaults.
const DEFAULT_RPC: Record<number, string> = {
  1: "https://ethereum.publicnode.com",
  56: "https://bsc-dataseed1.binance.org/",
  143: "https://rpc.monad.xyz",
  196: "https://rpc.xlayer.tech",
  988: "https://rpc.stable.xyz",
  1776: "https://sentry.evm-rpc.injective.network/",
  5000: "https://rpc.mantle.xyz",
  8453: "https://mainnet.base.org",
  42161: "https://arb1.arbitrum.io/rpc",
  43114: "https://api.avax.network/ext/bc/C/rpc",
  534352: "https://rpc.scroll.io",
};

const TRANSFER_AUTH_TYPES = {
  TransferAuthorization: [
    { name: "owner", type: "address" },
    { name: "facilitator", type: "address" },
    { name: "token", type: "address" },
    { name: "recipient", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

/**
 * Convert a human-readable decimal amount to a raw uint256 string, rejecting
 * any input that would lose precision through Number/parseFloat. Mirrors
 * toRawAmount in q402-sdk.js so server- and browser-signed payloads agree.
 */
export function toRawAmount(amount: string, decimals: number): string {
  if (typeof amount !== "string" || amount.trim() === "") {
    throw new Error('amount must be a non-empty decimal string (e.g. "5.00")');
  }
  if (!/^\d+(\.\d+)?$/.test(amount)) {
    throw new Error(
      `invalid amount "${amount}" - use a positive decimal string (no sign, no scientific notation, no whitespace)`,
    );
  }
  let raw: bigint;
  try {
    raw = parseUnits(amount, decimals);
  } catch {
    throw new Error(`amount "${amount}" exceeds ${decimals} decimal places`);
  }
  if (raw <= 0n) {
    throw new Error(`amount must be greater than zero (got "${amount}")`);
  }
  return raw.toString();
}

async function signAuthorization(
  wallet: Wallet,
  args: { chainId: number; address: string; nonce: number },
): Promise<{ chainId: number; address: string; nonce: number; yParity: number; r: string; s: string }> {
  // EIP-7702 protocol-level authorization signature.
  //
  //   message  = keccak256(0x05 || rlp([chainId, address, nonce]))
  //   r, s, yParity = secp256k1.sign(privateKey, message)
  //
  // ethers v6.16+ exposes `Wallet.authorize()` which produces exactly this
  // signature. The shape is NOT an EIP-712 typed digest - anything that
  // signs a typed digest over a custom domain produces a different
  // recovered address and the authorizationList silently fails to
  // delegate. The tx still succeeds as a no-op call into the
  // un-delegated EOA, so settlement appears to commit while no tokens
  // move. Wallets that already had a delegation persisted from a prior
  // (correctly-signed) authorization happen to work because the EOA
  // already has the impl code installed; fresh EOAs do not. Use
  // `Wallet.authorize()` only.
  const auth = await wallet.authorize({
    chainId: args.chainId,
    address: args.address,
    nonce: args.nonce,
  });
  return {
    chainId: Number(auth.chainId),
    address: auth.address,
    nonce: Number(auth.nonce),
    yParity: auth.signature.yParity,
    r: auth.signature.r,
    s: auth.signature.s,
  };
}

export class Q402NodeClient {
  private readonly opts: ClientOptions;

  constructor(opts: ClientOptions) {
    this.opts = opts;
  }

  /**
   * Build a TX-shaped explorer URL from the chain's explorer base.
   */
  static explorerUrl(chain: ChainConfig, txHash: string | undefined | null): string | null {
    if (!txHash) return null;
    return `${chain.explorer.replace(/\/$/, "")}/tx/${txHash}`;
  }

  async fetchFacilitator(): Promise<string> {
    const url = `${this.opts.relayBaseUrl.replace(/\/$/, "")}/relay/info`;
    // 10s timeout - facilitator info is a small read; if it takes longer
    // than that, the relay is unhealthy and we should fail the tool call
    // explicitly rather than hang the whole MCP session waiting.
    let resp: Response;
    try {
      resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      if (e instanceof Error && (e.name === "TimeoutError" || /aborted/i.test(e.message))) {
        throw new Error("Q402 relay didn't respond within 10s while reading facilitator info - the relay may be temporarily degraded. Safe to retry.");
      }
      throw e;
    }
    if (!resp.ok) {
      throw new Error(
        `failed to fetch relay facilitator info from ${url} (${resp.status})`,
      );
    }
    const data = (await resp.json()) as { facilitator?: string };
    if (!data.facilitator || typeof data.facilitator !== "string") {
      throw new Error("relay/info did not return a facilitator address");
    }
    return data.facilitator;
  }

  async pay(input: PayInput): Promise<PayResult> {
    const { chain, relayBaseUrl, apiKey, privateKey } = this.opts;
    const tokenCfg = tokenFor(chain, input.token);

    if (chain.supportedTokens && !chain.supportedTokens.includes(input.token)) {
      throw new Error(
        `token ${input.token} is not supported on chain ${chain.key}. ` +
          `Supported: ${chain.supportedTokens.join(", ")}.`,
      );
    }

    const amountRaw = toRawAmount(input.amount, tokenCfg.decimals);
    const deadline = Math.floor(Date.now() / 1000) + 600;

    const rpcUrl = this.opts.rpcUrl ?? DEFAULT_RPC[chain.chainId];
    if (!rpcUrl) {
      throw new Error(
        `no RPC URL configured for chain ${chain.key} (chainId ${chain.chainId})`,
      );
    }
    const provider = new JsonRpcProvider(rpcUrl);
    const wallet = new Wallet(privateKey, provider);
    const owner = await wallet.getAddress();

    const facilitator = await this.fetchFacilitator();

    const paymentNonce = toBigInt(randomBytes(32));

    const witnessSig = await wallet.signTypedData(
      {
        name: chain.domainName,
        version: "1",
        chainId: chain.chainId,
        verifyingContract: owner, // EIP-7702: address(this) resolves to the EOA
      },
      TRANSFER_AUTH_TYPES,
      {
        owner,
        facilitator,
        token: tokenCfg.address,
        recipient: input.to,
        amount: BigInt(amountRaw),
        nonce: paymentNonce,
        deadline: BigInt(deadline),
      },
    );

    const authNonce = await provider.getTransactionCount(owner);
    const authorization = await signAuthorization(wallet, {
      chainId: chain.chainId,
      address: chain.implContract,
      nonce: authNonce,
    });

    // The /api/relay route accepts three nonce field names depending on chain
    // (avax/bnb/eth/mantle/injective/monad/scroll → `nonce`, xlayer → `xlayerNonce`,
    // stable → `stableNonce`). The on-wire shape mirrors the browser SDK's
    // _payEIP7702 / _payXLayerEIP7702 / _payStableEIP7702 paths so the same
    // server route handles either client identically.
    const baseBody = {
      apiKey,
      chain: chain.key,
      token: input.token,
      from: owner,
      to: input.to,
      amount: amountRaw,
      deadline,
      witnessSig,
      authorization,
      facilitator,
    };
    const body =
      chain.key === "xlayer"
        ? { ...baseBody, xlayerNonce: paymentNonce.toString() }
        : chain.key === "stable"
          ? { ...baseBody, stableNonce: paymentNonce.toString() }
          : { ...baseBody, nonce: paymentNonce.toString() };

    // 30s timeout - single-recipient relay path. Real settlements typically
    // resolve in 1-3s; 30s is a generous ceiling so a stalled relay can't
    // hang the MCP tool indefinitely (which would block the whole AI turn).
    let resp: Response;
    try {
      resp = await fetch(`${relayBaseUrl.replace(/\/$/, "")}/relay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      // Turn the raw `TimeoutError: signal timed out` into something an
      // agent can actually relay to the user. Same translation applied
      // on batchPay() + fetchFacilitator() to keep the surface uniform.
      if (e instanceof Error && (e.name === "TimeoutError" || /aborted/i.test(e.message))) {
        throw new Error("Q402 relay didn't respond within 30s - the relay may be temporarily degraded. Safe to retry.");
      }
      throw e;
    }
    const data = (await resp.json()) as PayResult & { error?: string };
    if (!resp.ok) {
      throw new Error(data.error ?? `relay failed (HTTP ${resp.status})`);
    }
    data.mode = "live";
    data.explorerUrl = Q402NodeClient.explorerUrl(chain, data.txHash);
    return data;
  }

  /**
   * Multi-recipient settlement on a single chain + token. Trial keys can
   * fan out to at most 5 recipients per call; paid keys up to 20. The
   * server enforces the cap and rejects oversized batches with
   * `BATCH_TOO_LARGE`.
   *
   * Each recipient is independently authorised: one EIP-712
   * TransferAuthorization witness + one EIP-7702 authorization tuple
   * per row. The authorization nonces are issued sequentially starting
   * from the EOA's current on-chain nonce, so the EVM applies them
   * cleanly in batch order. Execution is sequential server-side; the
   * first transfer must succeed (it installs / re-confirms the
   * delegation), after which the remaining transfers are surfaced in
   * the result array even if individual ones fail.
   *
   * Signature shape: `{ token, recipients }`. The request body only ships
   * one token field, so a per-row token would be silently ignored. The
   * shape surfaces the constraint in the type so consumers can't
   * accidentally build a "mixed-token batch" that would quietly drop
   * the second token. Same chain + same token across one batch, full
   * stop.
   */
  async batchPay(input: { token: PayInput["token"]; recipients: Array<{ to: string; amount: string }> }): Promise<BatchPayResult> {
    const { token, recipients: rows } = input;
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error("batchPay requires at least one recipient");
    }
    if (typeof token !== "string") {
      throw new Error("batchPay({ token, recipients }): token must be a string");
    }

    const { chain, relayBaseUrl, apiKey, privateKey } = this.opts;

    // Token / chain compatibility, once for the whole batch.
    const tokenCfg = tokenFor(chain, token);
    if (chain.supportedTokens && !chain.supportedTokens.includes(token)) {
      throw new Error(
        `token ${token} is not supported on chain ${chain.key}. ` +
          `Supported: ${chain.supportedTokens.join(", ")}.`,
      );
    }

    // Pre-validate every recipient's amount before any signing - we don't
    // want to sign 4 of 5 transfers and only then discover the 5th had
    // a malformed amount.
    for (let i = 0; i < rows.length; i++) {
      try {
        toRawAmount(rows[i]!.amount, tokenCfg.decimals);
      } catch (e) {
        throw new Error(
          `recipient[${i}]: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // Chain scope for batchPay - default EIP-7702 mode only (avax / bnb /
    // eth / mantle / injective / monad / scroll). X Layer and Stable use chain-specific
    // nonce field shapes (xlayerNonce / stableNonce) and the X Layer USDC
    // path has an EIP-3009 fallback that doesn't install a delegation at
    // all - none of those compose cleanly with sequential first-failure-
    // abort batching today. The same scope is enforced in the server
    // route, the browser SDK, and the MCP tool schema so the supported-
    // chain claim is consistent across every surface.
    if (chain.key === "xlayer" || chain.key === "stable") {
      throw new Error(
        `batchPay does not yet support chain "${chain.key}". Supported batch chains: ` +
          `avax, bnb, eth, mantle, injective, monad, scroll (default EIP-7702 mode). ` +
          `For "${chain.key}" use pay() in a client-side loop.`,
      );
    }

    const rpcUrl = this.opts.rpcUrl ?? DEFAULT_RPC[chain.chainId];
    if (!rpcUrl) {
      throw new Error(
        `no RPC URL configured for chain ${chain.key} (chainId ${chain.chainId})`,
      );
    }
    const provider = new JsonRpcProvider(rpcUrl);
    const wallet = new Wallet(privateKey, provider);
    const owner = await wallet.getAddress();
    const facilitator = await this.fetchFacilitator();

    // Sequential EIP-7702 authorization nonces. The EVM expects each
    // authorization's nonce to equal the EOA's on-chain nonce at the
    // moment that tx lands. After the first batch tx lands, the EOA
    // nonce advances by 1; the second authorization (nonce = base + 1)
    // is valid for the second tx; and so on.
    const baseAuthNonce = await provider.getTransactionCount(owner);
    const deadline = Math.floor(Date.now() / 1000) + 600;

    const signedRows = [];
    for (let i = 0; i < rows.length; i++) {
      // noUncheckedIndexedAccess: rows[i] is typed as T | undefined even
      // though the loop bound guarantees presence. Assert here so the
      // rest of the loop body doesn't litter `!` operators.
      const row = rows[i]!;
      const amountRaw = toRawAmount(row.amount, tokenCfg.decimals);
      const paymentNonce = toBigInt(randomBytes(32));

      const witnessSig = await wallet.signTypedData(
        {
          name: chain.domainName,
          version: "1",
          chainId: chain.chainId,
          verifyingContract: owner,
        },
        TRANSFER_AUTH_TYPES,
        {
          owner,
          facilitator,
          token: tokenCfg.address,
          recipient: row.to,
          amount: BigInt(amountRaw),
          nonce: paymentNonce,
          deadline: BigInt(deadline),
        },
      );

      const authorization = await signAuthorization(wallet, {
        chainId: chain.chainId,
        address: chain.implContract,
        nonce: baseAuthNonce + i,
      });

      signedRows.push({
        from: owner,
        to: row.to,
        amount: amountRaw,
        nonce: paymentNonce.toString(),
        deadline,
        witnessSig,
        authorization,
      });
    }

    // Send the batch. 60s timeout - relay loops recipients sequentially,
    // so a 20-row paid batch can legitimately take 10-20s. 60s ceiling
    // keeps a stalled relay from pinning the MCP tool for the whole AI
    // turn while still allowing healthy batches to complete.
    let resp: Response;
    try {
      resp = await fetch(`${relayBaseUrl.replace(/\/$/, "")}/relay/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey,
          chain: chain.key,
          token,
          facilitator,
          recipients: signedRows,
        }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      if (e instanceof Error && (e.name === "TimeoutError" || /aborted/i.test(e.message))) {
        throw new Error("Q402 relay didn't respond within 60s on the batch path - the relay may be temporarily degraded. Safe to retry.");
      }
      throw e;
    }
    const data = (await resp.json()) as BatchPayResult & { error?: string };

    // Aborted batches (server returns 424) and partial failures (207) must
    // throw, not return. The server returns 200/ok:true even when
    // recipient[0] failed and the batch was abandoned - relying only on
    // !resp.ok would let q402_batch_pay report "batch sent" to the user
    // when zero transfers actually landed. The throw carries a
    // BatchPayError with the per-row results so callers can still surface
    // what landed and what didn't.
    if (!resp.ok || data.ok === false) {
      const err = new BatchPayError(
        data.aborted
          ? `Batch aborted: recipient[0] failed (${data.results?.[0]?.error ?? "unknown"}). No transfers landed.`
          : data.totalFailed > 0
            ? `Batch completed with ${data.totalFailed}/${data.results?.length ?? "?"} failed rows.`
            : (data.error ?? `relay/batch failed (HTTP ${resp.status})`),
        {
          aborted:      !!data.aborted,
          // Preserve the server's scope/limit so the MCP tool surface can
          // report the actual tier (trial vs paid) rather than guessing.
          // Falls back to "paid" / row count only when the failure didn't
          // come from the relay route (e.g. network-level error).
          scope:        data.scope ?? "paid",
          limit:        data.limit ?? signedRows.length,
          totalSuccess: data.totalSuccess ?? 0,
          totalFailed:  data.totalFailed  ?? signedRows.length,
          results:      data.results ?? [],
        },
      );
      throw err;
    }

    // Decorate each successful row with the explorer URL - same shape
    // single-recipient pay() returns, so agents can render uniformly.
    data.results = data.results.map((r) => ({
      ...r,
      ...(r.success && r.txHash
        ? { explorerUrl: Q402NodeClient.explorerUrl(chain, r.txHash) }
        : {}),
    }));
    return data;
  }
}

/**
 * Thrown by Q402NodeClient.batchPay() when the server rejected the batch
 * (aborted on first failure) or completed with at least one failed row.
 * Carries the same shape the success path returns so callers don't lose
 * the per-recipient results.
 */
export class BatchPayError extends Error {
  readonly aborted:      boolean;
  readonly scope:        "trial" | "paid";
  readonly limit:        number;
  readonly totalSuccess: number;
  readonly totalFailed:  number;
  readonly results:      BatchPayResult["results"];

  constructor(message: string, details: {
    aborted:      boolean;
    scope:        "trial" | "paid";
    limit:        number;
    totalSuccess: number;
    totalFailed:  number;
    results:      BatchPayResult["results"];
  }) {
    super(message);
    this.name         = "BatchPayError";
    this.aborted      = details.aborted;
    this.scope        = details.scope;
    this.limit        = details.limit;
    this.totalSuccess = details.totalSuccess;
    this.totalFailed  = details.totalFailed;
    this.results      = details.results;
  }
}

export interface BatchPayResult {
  ok: boolean;
  scope: "trial" | "paid";
  limit: number;
  totalSuccess: number;
  totalFailed: number;
  aborted: boolean;
  results: Array<{
    success: boolean;
    txHash?: string;
    blockNumber?: number;
    receiptId?: string;
    method?: string;
    explorerUrl?: string | null;
    error?: string;
    code?: string;
  }>;
}

/**
 * Sandbox path - signs nothing on-chain, returns a deterministic-looking
 * fake hash. Used when API key is absent / test-tier, real-payments flag
 * is off, or a private key is missing.
 */
export function sandboxPay(
  chain: ChainConfig,
  input: PayInput,
): PayResult {
  const tokenCfg = tokenFor(chain, input.token);
  const tokenAmount = toRawAmount(input.amount, tokenCfg.decimals);
  // 32-byte random hex - visually indistinguishable from a real tx hash but
  // never collides with one because we don't emit any transaction.
  const fakeHash = "0x" + hexlify(randomBytes(32)).slice(2);

  return {
    // `success: false` because no funds moved. The `sandbox: true` flag is
    // the canonical "this was a simulation" marker - downstream callers
    // should branch on EITHER field to avoid misreporting a settlement.
    success: false,
    sandbox: true,
    txHash: fakeHash,
    tokenAmount,
    token: input.token,
    chain: chain.key,
    method: "sandbox",
    mode: "sandbox",
    explorerUrl: null,
  };
}
