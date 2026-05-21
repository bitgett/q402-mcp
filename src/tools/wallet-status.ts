/**
 * q402_wallet_status — read-only, no API key required.
 *
 * Reports the EIP-7702 delegation state of the EOA derived from
 * Q402_PRIVATE_KEY across all 9 Q402-supported chains. Read-only:
 * no signing, no funds movement, no quota consumption.
 *
 * Useful as the diagnostic companion to `q402_clear_delegation` —
 * agents call this first to see which chains have an active
 * delegation, then call clear_delegation for the chains that need
 * it. Also handy when the user's wallet UI is showing a "Smart
 * account" indicator and they want to understand why.
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
  address?:  string;
  chains?:   Record<string, ChainState>;
  summary?:  string;
  /** Set when Q402_PRIVATE_KEY isn't available — the tool can't infer the
   *  EOA to query for, so it short-circuits with a clear hint. */
  error?:    string;
  hint?:     string;
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
  try {
    const res = await fetch(url);
    body = await res.json();
    if (!res.ok) {
      return {
        address,
        error: typeof body === "object" && body && "error" in body ? String((body as { error: unknown }).error) : `HTTP ${res.status}`,
      };
    }
  } catch (e) {
    return {
      address,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  const parsed = body as { address: string; chains: Record<string, ChainState>; summary: string };
  return {
    address:  parsed.address,
    chains:   parsed.chains,
    summary:  parsed.summary,
  };
}

export const WALLET_STATUS_TOOL = {
  name: "q402_wallet_status",
  description:
    "Report the EIP-7702 delegation status of your Q402 wallet (the EOA " +
    "derived from Q402_PRIVATE_KEY) across all 9 Q402-supported chains. " +
    "Returns per-chain { delegated, impl } and a one-line summary. Read-" +
    "only — no signing, no on-chain TX, no quota consumption. Use this " +
    "before q402_clear_delegation to figure out which chains need a " +
    "cleanup, or when answering 'why is my wallet showing Smart account?' " +
    "Requires Q402_PRIVATE_KEY in env (same as q402_pay).",
  inputSchema: {
    type: "object" as const,
    properties: {},
    additionalProperties: false,
  },
} as const;
