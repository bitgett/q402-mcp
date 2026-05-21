/**
 * q402_balance — read-only, requires at least one API key.
 *
 * Returns the API key's validity and plan tier from `/api/keys/verify` (POST).
 * The endpoint exposes `valid / address / plan / createdAt / remainingCredits`
 * and a trial summary (`isTrial / trialDaysLeft / trialExpiresAt`) when the
 * key is trial-scoped.
 *
 * Two-key model: when both Q402_TRIAL_API_KEY and Q402_MULTICHAIN_API_KEY
 * are set, this tool verifies both and returns both summaries so the model
 * can show the user the full picture in one read. Single-env legacy callers
 * (only Q402_API_KEY set) get a one-scope response as before.
 */

import { z } from "zod";
import { CONFIG, type KeyScope } from "../config.js";

export const BalanceInputSchema = z.object({});
export type BalanceInput = z.infer<typeof BalanceInputSchema>;

export interface ScopedVerifyResult {
  scope: KeyScope | "legacy";
  apiKeyMasked: string;
  verify: unknown;
  trial?: {
    daysLeft: number;
    expiresAt: string;
    creditsRemaining: number;
    signupUrl: string;
  };
}

export interface BalanceSummary {
  /**
   * Legacy fields. Mirror the most relevant scope so callers that only know
   * about the single-key shape keep working. Prefer `scopes` for new code.
   */
  apiKeyKind: "live" | "test" | "missing";
  apiKeyMasked: string | null;
  verify?: unknown;
  trial?: ScopedVerifyResult["trial"];

  /** Per-scope verification results. Empty when no key is configured. */
  scopes: ScopedVerifyResult[];

  dashboardUrl: string;
  setupHint?: string;
}

function mask(key: string | null): string | null {
  if (!key || key.length < 12) return null;
  return `${key.slice(0, 12)}…${key.slice(-4)}`;
}

async function verifyOne(apiKey: string): Promise<unknown> {
  const resp = await fetch(`${CONFIG.relayBaseUrl}/keys/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  return resp.ok ? await resp.json() : { error: `HTTP ${resp.status}` };
}

function extractTrial(verifyJson: unknown): ScopedVerifyResult["trial"] | undefined {
  const v = verifyJson as {
    isTrial?: boolean;
    trialExpiresAt?: string;
    trialDaysLeft?: number;
    remainingCredits?: number;
  };
  if (!v || !v.isTrial || typeof v.trialExpiresAt !== "string") return undefined;
  return {
    daysLeft: typeof v.trialDaysLeft === "number" ? v.trialDaysLeft : 0,
    expiresAt: v.trialExpiresAt,
    creditsRemaining: typeof v.remainingCredits === "number" ? v.remainingCredits : 0,
    signupUrl: "https://q402.quackai.ai",
  };
}

export async function runBalance(): Promise<BalanceSummary> {
  // Build the per-scope list. Each entry is verified independently so a
  // typo'd trial key doesn't mask the multichain key's validity.
  const targets: Array<{ scope: ScopedVerifyResult["scope"]; key: string }> = [];
  if (CONFIG.trialApiKey)      targets.push({ scope: "trial",      key: CONFIG.trialApiKey });
  if (CONFIG.multichainApiKey) targets.push({ scope: "multichain", key: CONFIG.multichainApiKey });
  // Only emit the legacy entry when neither scoped key is set — otherwise
  // it'd duplicate one of the entries above.
  if (targets.length === 0 && CONFIG.legacyApiKey) {
    targets.push({ scope: "legacy", key: CONFIG.legacyApiKey });
  }

  if (targets.length === 0) {
    return {
      apiKeyKind: "missing",
      apiKeyMasked: null,
      scopes: [],
      dashboardUrl: "https://q402.quackai.ai/dashboard",
      setupHint:
        "No API key configured. Call q402_doctor for guided setup — it will " +
        "offer to create ~/.q402/mcp.env with placeholders that the user can " +
        "fill in. (Manual path: set Q402_TRIAL_API_KEY for BNB-only sponsored " +
        "(free at https://q402.quackai.ai/event) and/or Q402_MULTICHAIN_API_KEY " +
        "for paid 9-chain (https://q402.quackai.ai/payment). Q402_API_KEY is " +
        "the legacy single-env fallback.)",
    };
  }

  const scopes: ScopedVerifyResult[] = await Promise.all(
    targets.map(async ({ scope, key }) => {
      const verify = await verifyOne(key);
      return {
        scope,
        apiKeyMasked: mask(key) ?? key,
        verify,
        trial: extractTrial(verify),
      };
    }),
  );

  // Legacy alias: surface the multichain scope's data first, else trial,
  // else legacy. Keeps single-scope consumers working without changes.
  // targets.length > 0 was guaranteed above (early return otherwise), so
  // scopes is non-empty and the final fallback is always defined.
  const primary =
    scopes.find(s => s.scope === "multichain") ??
    scopes.find(s => s.scope === "trial") ??
    scopes[0]!;

  return {
    apiKeyKind: CONFIG.apiKeyKind,
    apiKeyMasked: primary.apiKeyMasked,
    verify: primary.verify,
    trial: primary.trial,
    scopes,
    dashboardUrl: "https://q402.quackai.ai/dashboard",
  };
}

export const BALANCE_TOOL = {
  name: "q402_balance",
  description:
    "Verify the configured API key(s) and report each one's plan tier (live vs sandbox vs trial). " +
    "Read-only. When both Q402_TRIAL_API_KEY and Q402_MULTICHAIN_API_KEY are set, returns " +
    "BOTH summaries so the agent can show the user trial credits AND paid credits in one view. " +
    "For trial-scoped keys, returns days-left + credits-remaining for the trial allotment. " +
    "Free trial available at https://q402.quackai.ai/event — 2,000 gasless TX over 30 days. " +
    "For per-chain gas tank balances, point the user at https://q402.quackai.ai/dashboard — " +
    "those need a wallet signature, not a bare key.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    additionalProperties: false,
  },
} as const;
