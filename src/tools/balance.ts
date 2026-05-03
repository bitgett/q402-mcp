/**
 * q402_balance — read-only, requires an API key.
 *
 * Returns the API key's validity and plan tier from `/api/keys/verify` (POST).
 * The endpoint currently exposes `valid / address / plan / createdAt`; it does
 * NOT include remaining daily quota or per-chain gas-tank balances. Those need
 * a wallet signature and live in the dashboard at https://q402.quackai.ai/dashboard.
 *
 * If the verify endpoint is ever extended to include `remainingCredits` /
 * `quotaBonus`, this tool's response shape passes them through automatically
 * (we forward the whole `verify` blob), so no MCP-side change is required.
 */

import { z } from "zod";
import { CONFIG } from "../config.js";

export const BalanceInputSchema = z.object({});
export type BalanceInput = z.infer<typeof BalanceInputSchema>;

export interface BalanceSummary {
  apiKeyKind: "live" | "test" | "missing";
  /** Pre-redacted form of the API key for display. Never returns the full key. */
  apiKeyMasked: string | null;
  /** Raw response from /api/keys/verify (valid flag, address, plan, quota …). */
  verify?: unknown;
  /** Pointer for the agent when richer data is needed. */
  dashboardUrl: string;
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
      dashboardUrl: "https://q402.quackai.ai/dashboard",
      setupHint:
        "Set Q402_API_KEY to a key issued at https://q402.quackai.ai/dashboard. " +
        "Test-tier keys (q402_test_*) work too — they show sandbox quota.",
    };
  }

  const resp = await fetch(`${CONFIG.relayBaseUrl}/keys/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: CONFIG.apiKey }),
  });
  const verifyJson = resp.ok ? await resp.json() : { error: `HTTP ${resp.status}` };

  return {
    apiKeyKind: CONFIG.apiKeyKind,
    apiKeyMasked: mask(CONFIG.apiKey),
    verify: verifyJson,
    dashboardUrl: "https://q402.quackai.ai/dashboard",
  };
}

export const BALANCE_TOOL = {
  name: "q402_balance",
  description:
    "Verify the configured API key and report its plan tier (live vs sandbox). Read-only. " +
    "For remaining daily quota and per-chain gas tank balances, point the user at " +
    "https://q402.quackai.ai/dashboard — those need a wallet signature, not a bare key.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    additionalProperties: false,
  },
} as const;
