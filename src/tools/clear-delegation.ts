/**
 * q402_clear_delegation — write, requires Q402_PRIVATE_KEY.
 *
 * Clears the EIP-7702 delegation on a specific chain for the EOA derived
 * from Q402_PRIVATE_KEY. The signing happens locally inside this process
 * (so the private key never leaves the user's machine), and the signed
 * authorization is POSTed to Q402's /api/wallet/clear-delegation
 * endpoint which broadcasts the type-0x04 TX from the sponsor wallet
 * (gas paid by Q402 — the user pays nothing).
 *
 * After clearing, `eth_getCode` for that EOA on that chain returns
 * `0x` again. The next q402_pay on the same chain auto-creates a fresh
 * delegation (no permanent state change).
 */

import { z } from "zod";
import { Wallet, JsonRpcProvider } from "ethers";
import { CONFIG } from "../config.js";
import { CHAIN_CONFIG, CHAIN_KEYS, type ChainKey } from "../chains.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Default RPC per chain — mirrors mcp-server/src/client.ts so the
// nonce lookup uses the same RPC defaults the rest of the package does.
const DEFAULT_RPC: Record<number, string> = {
  1:      "https://ethereum.publicnode.com",
  56:     "https://bsc-dataseed1.binance.org/",
  143:    "https://rpc.monad.xyz",
  196:    "https://rpc.xlayer.tech",
  988:    "https://rpc.stable.xyz",
  1776:   "https://sentry.evm-rpc.injective.network/",
  5000:   "https://rpc.mantle.xyz",
  42161:  "https://arb1.arbitrum.io/rpc",
  43114:  "https://api.avax.network/ext/bc/C/rpc",
  534352: "https://rpc.scroll.io",
};

export const ClearDelegationInputSchema = z.object({
  chain: z
    .enum(["avax", "bnb", "eth", "xlayer", "stable", "mantle", "injective", "monad", "scroll", "arbitrum"])
    .describe("Which Q402 chain to clear the delegation on."),
});

export type ClearDelegationInput = z.infer<typeof ClearDelegationInputSchema>;

interface ClearDelegationResult {
  ok:           boolean;
  chain?:       ChainKey;
  address?:     string;
  txHash?:      string;
  blockNumber?: number;
  gasUsed?:     string;
  explorerUrl?: string;
  /** True when the post-broadcast eth_getCode returns 0x — confirms the
   *  delegation is actually gone. False (or absent) means the TX confirmed
   *  but the on-chain state didn't update — likely a stale authorization
   *  nonce; retry after refreshing the wallet's tx count. */
  cleared?:     boolean;
  /** When ok=false, machine-readable code. */
  error?:       string;
  /** When ok=false, human-readable next step. */
  hint?:        string;
}

export async function runClearDelegation(input: ClearDelegationInput): Promise<ClearDelegationResult> {
  if (!CONFIG.privateKey) {
    return {
      ok:    false,
      error: "MISSING_PRIVATE_KEY",
      hint:  "Set Q402_PRIVATE_KEY in the MCP environment — same key q402_pay uses. The MCP tool signs locally and never sends the key to Q402.",
    };
  }

  const cfg = CHAIN_CONFIG[input.chain];
  if (!cfg) {
    return { ok: false, error: "INVALID_CHAIN", hint: `Unknown chain: ${input.chain}` };
  }

  // ── 1. Derive EOA + read current nonce ────────────────────────────────
  let wallet: Wallet;
  try {
    const provider = new JsonRpcProvider(DEFAULT_RPC[cfg.chainId]);
    wallet = new Wallet(CONFIG.privateKey, provider);
  } catch {
    return {
      ok:    false,
      error: "INVALID_PRIVATE_KEY",
      hint:  "Q402_PRIVATE_KEY is set but does not parse as a valid 32-byte hex private key.",
    };
  }

  const address = wallet.address;
  let nonce: number;
  try {
    nonce = await wallet.provider!.getTransactionCount(address);
  } catch (e) {
    return {
      ok:    false,
      address,
      error: "RPC_FAILED",
      hint:  `Could not read transaction count for ${address} on ${input.chain}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // ── 2. Sign EIP-7702 authorization (address = 0x0 → clear) ────────────
  // ethers v6 `wallet.authorize()` handles the spec-correct RLP+keccak
  // encoding and produces the canonical { chainId, address, nonce,
  // signature } object. Sponsored mode: target's nonce isn't bumped by
  // its own TX (the sponsor sends it), so the authorization nonce
  // equals the current eth_getTransactionCount value.
  let auth;
  try {
    auth = await wallet.authorize({
      chainId: cfg.chainId,
      address: ZERO_ADDRESS,
      nonce,
    });
  } catch (e) {
    return {
      ok:    false,
      address,
      error: "SIGN_FAILED",
      hint:  `Local signing failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // ── 3. POST to Q402 for sponsored broadcast ───────────────────────────
  const url  = `${CONFIG.relayBaseUrl.replace(/\/$/, "")}/wallet/clear-delegation`;
  const body = {
    chain:   input.chain,
    address,
    authorization: {
      chainId: Number(auth.chainId),
      address: auth.address,
      nonce:   Number(auth.nonce),
      yParity: auth.signature.yParity,
      r:       auth.signature.r,
      s:       auth.signature.s,
    },
  };

  let res: Response;
  let json: unknown;
  try {
    // 30s timeout — write path: sponsor wallet has to mine the
    // type-0x04 TX. Real BNB confirmation is 3-5s, headroom for
    // congested chains; anything beyond 30s means the relay or
    // chain is degraded and the user should retry.
    res  = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(30_000),
    });
    json = await res.json();
  } catch (e) {
    return {
      ok:    false,
      address,
      error: "RELAY_UNREACHABLE",
      hint:  `Could not reach Q402 relay at ${url}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // The endpoint returns 422 (not 200) when the TX confirmed but the
  // on-chain state didn't actually clear — typically a stale authorization
  // nonce. In that case `json` still carries the diagnostic fields
  // (txHash, finalCode) so we surface them alongside the error.
  const payload = json as {
    ok?:          boolean;
    txHash?:      string;
    blockNumber?: number;
    gasUsed?:     string;
    finalCode?:   string;
    cleared?:     boolean;
    explorerUrl?: string;
    error?:       string;
    reason?:      string;
  };

  if (!res.ok || payload.cleared !== true) {
    return {
      ok:          false,
      chain:       input.chain,
      address,
      txHash:      payload.txHash,
      blockNumber: payload.blockNumber,
      gasUsed:     payload.gasUsed,
      cleared:     payload.cleared ?? false,
      explorerUrl: payload.explorerUrl,
      error:       payload.error ?? `HTTP ${res.status}`,
      hint:        payload.reason ?? "The sponsored TX did not clear the delegation. If a txHash is present, the broadcast confirmed but the EOA's code is still non-empty (commonly a stale nonce) — refresh and retry.",
    };
  }

  return {
    ok:          true,
    chain:       input.chain,
    address,
    txHash:      payload.txHash!,
    blockNumber: payload.blockNumber!,
    gasUsed:     payload.gasUsed!,
    cleared:     true,
    explorerUrl: payload.explorerUrl!,
  };
}

export const CLEAR_DELEGATION_TOOL = {
  name: "q402_clear_delegation",
  description:
    "Clear the EIP-7702 delegation on a Q402 chain for the configured wallet. " +
    "Call this only when the user explicitly asks to reset or clean up their " +
    "Q402 wallet on a chain — the next q402_pay will recreate the delegation " +
    "automatically, so calling clear right before another payment just wastes " +
    "a TX. Pair with q402_wallet_status first to see which chains actually " +
    "have an active delegation. " +
    "Signing happens locally with Q402_PRIVATE_KEY (same key q402_pay uses); " +
    "Q402 sponsors the on-chain TX so the user pays zero gas.",
  inputSchema: {
    type: "object" as const,
    properties: {
      chain: {
        type: "string",
        enum: CHAIN_KEYS as readonly string[],
        description: "Which Q402 chain to clear the delegation on.",
      },
    },
    required: ["chain"],
    additionalProperties: false,
  },
} as const;
