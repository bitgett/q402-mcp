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
