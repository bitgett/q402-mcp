/**
 * q402_balance — read-only, requires an API key.
 *
 * Returns gas tank balances and remaining daily quota for the configured key.
 * Calls the public q402-landing endpoints `/api/wallet-balance` and
 * `/api/keys/verify` (both already exposed in production).
 */

import { z } from "zod";
import { CONFIG } from "../config.js";

export const BalanceInputSchema = z.object({});
export type BalanceInput = z.infer<typeof BalanceInputSchema>;

export interface BalanceSummary {
  apiKeyKind: "live" | "test" | "missing";
  /** Pre-redacted form of the API key for display. Never returns the full key. */
  apiKeyMasked: string | null;
  walletBalances?: unknown;
  quotaRemaining?: unknown;
  setupHint?: string;
}

function mask(key: string | null): string | null {
  if (!key || key.length < 12) return null;
  return `${key.slice(0, 12)}…${key.slice(-4)}`;
}

export async function runBalance(): Promise<BalanceSummary> {
  if (CONFIG.apiKeyKind === "missing") {
    return {
      apiKeyKind: "missing",
      apiKeyMasked: null,
      setupHint:
        "Set Q402_API_KEY to a key issued at https://q402.quackai.ai/dashboard. " +
        "Test-tier keys (q402_test_*) work too — they show sandbox quota and balances.",
    };
  }

  const headers = { "Content-Type": "application/json" };
  const base = CONFIG.relayBaseUrl;

  const [walletResp, verifyResp] = await Promise.all([
    fetch(`${base}/wallet-balance?apiKey=${encodeURIComponent(CONFIG.apiKey!)}`, { headers }),
    fetch(`${base}/keys/verify`, {
      method: "POST",
      headers,
      body: JSON.stringify({ apiKey: CONFIG.apiKey }),
    }),
  ]);

  const walletJson = walletResp.ok ? await walletResp.json() : { error: `HTTP ${walletResp.status}` };
  const verifyJson = verifyResp.ok ? await verifyResp.json() : { error: `HTTP ${verifyResp.status}` };

  return {
    apiKeyKind: CONFIG.apiKeyKind,
    apiKeyMasked: mask(CONFIG.apiKey),
    walletBalances: walletJson,
    quotaRemaining: verifyJson,
  };
}

export const BALANCE_TOOL = {
  name: "q402_balance",
  description:
    "Show the configured API key's gas tank balances per chain and remaining daily quota. " +
    "Read-only — no transactions are sent. Useful before q402_pay when the user wants to " +
    "confirm they have gas credit on the target chain.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    additionalProperties: false,
  },
} as const;
