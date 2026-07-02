/**
 * q402_wallet_status — read-only, no API key required.
 *
 * Reports the EIP-7702 delegation state of the EOA derived from
 * Q402_PRIVATE_KEY across all 12 Q402-supported chains. Read-only:
 * no signing, no funds movement, no quota consumption.
 *
 * Useful as the diagnostic companion to `q402_clear_delegation` —
 * agents call this first to see which chains have an active
 * delegation, then call clear_delegation for the chains the user
 * wants to reset.
 */

import { z } from "zod";
import { Wallet } from "ethers";
import { CONFIG } from "../config.js";

export const WalletStatusInputSchema = z.object({});
export type WalletStatusInput = z.infer<typeof WalletStatusInputSchema>;

interface ChainState {
  delegated: boolean;
  impl?:     string;
  error?:    string;
}

interface WalletStatusResult {
  address?:       string;
  chains?:        Record<string, ChainState>;
  summary?:       string;
  /** Set when Q402_PRIVATE_KEY isn't available or the relay endpoint
   *  rejected the request — the tool short-circuits with a clear hint. */
  error?:         string;
  hint?:          string;
  /** When the relay returned 429 RATE_LIMITED, this carries the cooldown
   *  in seconds so the agent can tell the user when to retry instead of
   *  silently swallowing the limit. */
  retryAfterSec?: number;
}

export async function runWalletStatus(): Promise<WalletStatusResult> {
  if (!CONFIG.privateKey) {
    return {
      error: "MISSING_PRIVATE_KEY",
      hint:  "Set Q402_PRIVATE_KEY in the MCP environment so this tool can derive the EOA to inspect.",
    };
  }

  let address: string;
  try {
    address = new Wallet(CONFIG.privateKey).address;
  } catch {
    return {
      error: "INVALID_PRIVATE_KEY",
      hint:  "Q402_PRIVATE_KEY is set but does not parse as a valid 32-byte hex private key.",
    };
  }

  const url = `${CONFIG.relayBaseUrl.replace(/\/$/, "")}/wallet/delegation-status?address=${address}`;
  let body: unknown;
  let res:  Response;
  try {
    // 10s timeout — endpoint fans out 9 parallel eth_getCode calls on
    // the server but completes in 200-500ms when healthy. A stall past
    // 10s means the relay is unhealthy; bail rather than hang the tool.
    res  = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    body = await res.json();
  } catch (e) {
    return {
      address,
      error: "RELAY_UNREACHABLE",
      hint:  `Could not reach Q402 at ${url}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!res.ok) {
    // Propagate the relay's structured fields (retryAfterSec, hint) so the
    // agent can tell the user something useful — e.g. "try again in N
    // seconds" on a 429 instead of a bare HTTP code.
    const errBody = body as { error?: string; reason?: string; hint?: string; retryAfterSec?: number };
    return {
      address,
      error:         errBody.error ?? `HTTP ${res.status}`,
      hint:          errBody.hint ?? errBody.reason,
      retryAfterSec: errBody.retryAfterSec,
    };
  }

  const parsed = body as { address: string; chains: Record<string, ChainState>; summary: string };
  return {
    address: parsed.address,
    chains:  parsed.chains,
    summary: parsed.summary,
  };
}

export const WALLET_STATUS_TOOL = {
  name: "q402_wallet_status",
  description:
    "Report the EIP-7702 delegation status of your Q402 wallet (the EOA " +
    "derived from Q402_PRIVATE_KEY) across all 12 Q402-supported chains. " +
    "Returns per-chain { delegated, impl } and a one-line summary. Read-" +
    "only — no signing, no on-chain TX, no quota consumption. Pair with " +
    "q402_clear_delegation when the user wants to reset a specific chain. " +
    "Requires Q402_PRIVATE_KEY in env (same as q402_pay).",
  inputSchema: {
    type: "object" as const,
    properties: {},
    additionalProperties: false,
  },
} as const;
