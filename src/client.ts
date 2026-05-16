/**
 * Server-side Q402 client — Node.js variant of public/q402-sdk.js.
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
  success: boolean;
  txHash: string;
  blockNumber?: string;
  tokenAmount: string;
  token: "USDC" | "USDT" | "RLUSD";
  chain: string;
  method: string;
  /** Set on sandbox / simulated responses so the agent can disclose mode. */
  mode?: "sandbox" | "live";
  explorerUrl?: string | null;
}

export interface PayInput {
  to: string;
  amount: string;
  token: "USDC" | "USDT" | "RLUSD";
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
  43114: "https://api.avax.network/ext/bc/C/rpc",
  196: "https://rpc.xlayer.tech",
  988: "https://rpc.stable.xyz",
  5000: "https://rpc.mantle.xyz",
  1776: "https://sentry.evm-rpc.injective.network/",
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
      `invalid amount "${amount}" — use a positive decimal string (no sign, no scientific notation, no whitespace)`,
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
  // signature. An earlier revision of this file signed an EIP-712 typed
  // digest over a custom domain instead — wrong message, the EVM
  // ecrecovered a different address and the authorizationList silently
  // failed to delegate. Tx still succeeded as a no-op call into the
  // un-delegated EOA, so settlement appeared to commit while no tokens
  // moved.
  //
  // Wallets that had a delegation persisted from a prior (correctly-
  // signed) authorization happened to work because the EOA already had
  // the impl code installed; fresh EOAs broke. Hence this is the root
  // fix for any first-time-binding wallet on the trial flow.
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
    const resp = await fetch(url);
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
    // (avax/bnb/eth/mantle/injective → `nonce`, xlayer → `xlayerNonce`,
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

    const resp = await fetch(`${relayBaseUrl.replace(/\/$/, "")}/relay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
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
   * Signature shape: `{ token, recipients }`. The previous revision took
   * `PayInput[]` (with token on each row), which read as if rows could
   * carry different tokens — but the request body only ships one token
   * field, so the per-row token on rows 1..N was silently ignored.
   * Codex audit P2: surface the constraint in the type so consumers
   * can't accidentally build a "mixed-token batch" that quietly drops
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

    // Pre-validate every recipient's amount before any signing — we don't
    // want to sign 4 of 5 transfers and only then discover the 5th had
    // a malformed amount.
    for (let i = 0; i < rows.length; i++) {
      try {
        toRawAmount(rows[i].amount, tokenCfg.decimals);
      } catch (e) {
        throw new Error(
          `recipient[${i}]: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // Chain scope for batchPay — default EIP-7702 mode only (avax / bnb /
    // eth / mantle / injective). X Layer and Stable use chain-specific
    // nonce field shapes (xlayerNonce / stableNonce) and the X Layer USDC
    // path has an EIP-3009 fallback that doesn't install a delegation at
    // all — none of those compose cleanly with sequential first-failure-
    // abort batching today. Codex audit P2-A: keep the supported-chain
    // claim consistent across browser SDK / Node client / docs.
    if (chain.key === "xlayer" || chain.key === "stable") {
      throw new Error(
        `batchPay does not yet support chain "${chain.key}". Supported batch chains: ` +
          `avax, bnb, eth, mantle, injective (default EIP-7702 mode). ` +
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
      const row = rows[i];
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

    // Send the batch.
    const resp = await fetch(`${relayBaseUrl.replace(/\/$/, "")}/relay/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey,
        chain: chain.key,
        token,
        facilitator,
        recipients: signedRows,
      }),
    });
    const data = (await resp.json()) as BatchPayResult & { error?: string };

    // Aborted batches (server returns 424) and partial failures (207) must
    // throw, not return — earlier revision only threw on !resp.ok but the
    // server then returned 200/ok:true even when recipient[0] failed and
    // the batch was abandoned. Agents calling q402_batch_pay would have
    // reported "batch sent" to the user even though zero transfers landed.
    // Codex audit P1: throw a BatchPayError carrying the per-row results
    // so callers can still surface what landed and what didn't.
    if (!resp.ok || data.ok === false) {
      const err = new BatchPayError(
        data.aborted
          ? `Batch aborted: recipient[0] failed (${data.results?.[0]?.error ?? "unknown"}). No transfers landed.`
          : data.totalFailed > 0
            ? `Batch completed with ${data.totalFailed}/${data.results?.length ?? "?"} failed rows.`
            : (data.error ?? `relay/batch failed (HTTP ${resp.status})`),
        {
          aborted:      !!data.aborted,
          totalSuccess: data.totalSuccess ?? 0,
          totalFailed:  data.totalFailed  ?? signedRows.length,
          results:      data.results ?? [],
        },
      );
      throw err;
    }

    // Decorate each successful row with the explorer URL — same shape
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
  readonly aborted: boolean;
  readonly totalSuccess: number;
  readonly totalFailed: number;
  readonly results: BatchPayResult["results"];

  constructor(message: string, details: {
    aborted: boolean;
    totalSuccess: number;
    totalFailed: number;
    results: BatchPayResult["results"];
  }) {
    super(message);
    this.name         = "BatchPayError";
    this.aborted      = details.aborted;
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
 * Sandbox path — signs nothing on-chain, returns a deterministic-looking
 * fake hash. Used when API key is absent / test-tier, real-payments flag
 * is off, or a private key is missing.
 */
export function sandboxPay(
  chain: ChainConfig,
  input: PayInput,
): PayResult {
  const tokenCfg = tokenFor(chain, input.token);
  const tokenAmount = toRawAmount(input.amount, tokenCfg.decimals);
  // 32-byte random hex — visually indistinguishable from a real tx hash but
  // never collides with one because we don't emit any transaction.
  const fakeHash = "0x" + hexlify(randomBytes(32)).slice(2);

  return {
    success: true,
    txHash: fakeHash,
    tokenAmount,
    token: input.token,
    chain: chain.key,
    method: "sandbox",
    mode: "sandbox",
    explorerUrl: null,
  };
}
