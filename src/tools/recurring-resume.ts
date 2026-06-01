/**
 * q402_recurring_resume — resume a paused or stuck recurring-payment rule.
 *
 * Mode-C-only (apiKey auth). Brings a rule back to status "active" from
 * paused, paused-by-archive (after the wallet is restored), or
 * fired-cap-exceeded (after the user raised their per-tx cap or
 * re-subscribed to a paid Multichain plan). nextRunAt is rolled
 * forward to the next valid slot ≥ now + cancelWindow so the rule
 * doesn't immediately fire on a stale schedule.
 *
 * Use this when the user says "turn my Friday payout back on", "I
 * upped my per-tx cap, restart the rule", or "I re-subscribed —
 * resume my recurring schedules". List first with q402_recurring_list
 * to find the ruleId.
 *
 * Hits POST /api/wallet/agentic/recurring-by-key { action: "resume", ruleId }.
 */

import { z } from "zod";
import { CONFIG } from "../config.js";

export const RecurringResumeInputSchema = z.object({
  ruleId: z
    .string()
    .min(1)
    .describe(
      "Rule id to resume. Obtain from q402_recurring_list — each entry's " +
        "`ruleId` field. Resume is immediate; nextRunAt advances to the next " +
        "valid slot.",
    ),
  walletId: z
    .string()
    .optional()
    .describe(
      "Optional lowercased Agent Wallet address when the user holds multiple " +
        "wallets. Defaults to Q402_AGENT_WALLET_ADDRESS env, then the owner's " +
        "default wallet.",
    ),
});
export type RecurringResumeInput = z.infer<typeof RecurringResumeInputSchema>;

export const RECURRING_RESUME_TOOL = {
  name: "q402_recurring_resume",
  description:
    "Resume a paused or stopped recurring-payment rule. Takes a ruleId " +
    "(from q402_recurring_list). Supported transitions: paused → active, " +
    "paused-by-archive → active (after restoring the wallet), and " +
    "fired-cap-exceeded → active (after raising the per-tx cap or " +
    "re-subscribing). nextRunAt is advanced to the next valid slot so the " +
    "rule doesn't immediately fire on a stale schedule. Cancelled rules " +
    "cannot be resumed — re-author via q402_recurring_create. Authenticated " +
    "by the paid Multichain API key.",
  inputSchema: {
    type: "object" as const,
    properties: {
      ruleId: {
        type: "string" as const,
        description: "Rule id from q402_recurring_list. Required.",
      },
      walletId: {
        type: "string" as const,
        description:
          "Optional. Lowercased Agent Wallet address when the user holds multiple " +
          "wallets. Defaults to Q402_AGENT_WALLET_ADDRESS env, then the owner's " +
          "default wallet on the server.",
      },
    },
    required: ["ruleId"],
    additionalProperties: false,
  },
};

interface RuleSummary {
  ruleId:    string;
  walletId:  string;
  status:    string;
  frequency: string;
  chain:     string;
  token:     string;
}

export interface RecurringResumeResult {
  ok:           boolean;
  walletId:     string | null;
  rule:         RuleSummary | null;
  error?:       string;
  message?:     string;
  dashboardUrl: string;
}

export async function runRecurringResume(
  input: RecurringResumeInput,
): Promise<RecurringResumeResult> {
  const base = CONFIG.relayBaseUrl;
  const dashboardUrl = base.replace(/\/api$/, "") + "/dashboard?tab=agent";

  if (!CONFIG.apiKey || !CONFIG.apiKey.startsWith("q402_live_")) {
    return {
      ok:           false,
      walletId:     null,
      rule:         null,
      error:        "API_KEY_REQUIRED",
      message:
        "No live Q402 API key configured. Run q402_doctor to set one up.",
      dashboardUrl,
    };
  }
  if (!CONFIG.multichainApiKey || !CONFIG.multichainApiKey.startsWith("q402_live_")) {
    return {
      ok:       false,
      walletId: null,
      rule:     null,
      error:    "MULTICHAIN_KEY_REQUIRED",
      message:
        "Recurring payments require a paid Multichain API key " +
        "(Q402_MULTICHAIN_API_KEY). Activate a paid plan at " +
        "https://q402.quackai.ai/payment.",
      dashboardUrl,
    };
  }

  const explicitWalletId =
    typeof input.walletId === "string" && input.walletId.length > 0
      ? input.walletId.toLowerCase()
      : CONFIG.walletId;

  try {
    const res = await fetch(`${base}/wallet/agentic/recurring-by-key`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        apiKey: CONFIG.apiKey,
        action: "resume",
        ruleId: input.ruleId,
        ...(explicitWalletId ? { walletId: explicitWalletId } : {}),
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      walletId?: string;
      rule?:     RuleSummary;
      error?:    string;
      message?:  string;
    };
    if (!res.ok) {
      return {
        ok:           false,
        walletId:     explicitWalletId,
        rule:         null,
        error:        data.error ?? `HTTP_${res.status}`,
        message:      data.message ?? `Resume failed with HTTP ${res.status}.`,
        dashboardUrl,
      };
    }
    return {
      ok:           true,
      walletId:     data.walletId ?? explicitWalletId,
      rule:         data.rule ?? null,
      dashboardUrl,
    };
  } catch (e) {
    return {
      ok:           false,
      walletId:     explicitWalletId,
      rule:         null,
      error:        "NETWORK_ERROR",
      message:      e instanceof Error ? e.message : String(e),
      dashboardUrl,
    };
  }
}
