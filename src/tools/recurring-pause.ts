/**
 * q402_recurring_pause — pause an active recurring-payment rule.
 *
 * Mode-C-only (apiKey auth). Paused rules stay in KV with status
 * "paused" but the cron skips them. Resume with q402_recurring_resume
 * to bring the rule back to active without re-authoring it.
 *
 * Use this when the user says "stop my weekly payout for now" or
 * "pause my Friday rule until I sort out the recipient" — a milder
 * action than cancel, fully reversible. List first with
 * q402_recurring_list to find the ruleId.
 *
 * Hits POST /api/wallet/agentic/recurring-by-key { action: "pause", ruleId }.
 */

import { z } from "zod";
import { CONFIG } from "../config.js";

export const RecurringPauseInputSchema = z.object({
  ruleId: z
    .string()
    .min(1)
    .describe(
      "Rule id to pause. Obtain from q402_recurring_list — each entry's " +
        "`ruleId` field. Pausing is immediate and reversible.",
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
export type RecurringPauseInput = z.infer<typeof RecurringPauseInputSchema>;

export const RECURRING_PAUSE_TOOL = {
  name: "q402_recurring_pause",
  description:
    "Pause an active recurring-payment rule. Takes a ruleId (from " +
    "q402_recurring_list). The rule transitions to status \"paused\" — the " +
    "cron skips it on every tick until you resume. Fully reversible via " +
    "q402_recurring_resume. Use this when the user says 'pause my Friday " +
    "payout' or 'hold on, stop my recurring rule for now' — gentler than " +
    "cancel, no re-authoring required. Authenticated by the paid Multichain " +
    "API key (same gate as create/cancel). Read q402_recurring_list first " +
    "to find the matching ruleId.",
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

export interface RecurringPauseResult {
  ok:           boolean;
  walletId:     string | null;
  rule:         RuleSummary | null;
  error?:       string;
  message?:     string;
  dashboardUrl: string;
}

export async function runRecurringPause(
  input: RecurringPauseInput,
): Promise<RecurringPauseResult> {
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
        action: "pause",
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
        message:      data.message ?? `Pause failed with HTTP ${res.status}.`,
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
