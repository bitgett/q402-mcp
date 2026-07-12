/**
 * q402_recurring_skip_next - skip the next scheduled fire for a
 * recurring-payment rule.
 *
 * Mode-C-only (apiKey auth). Advances nextRunAt past the upcoming
 * slot to the one after. Useful when the user wants to honour the
 * cadence but not this specific upcoming payment - e.g. "skip Alice's
 * payout next Friday because she's on holiday, resume the Friday
 * after". One-shot: only the next slot is skipped; subsequent fires
 * continue normally.
 *
 * The rule must be in "active" status. Paused / cancelled rules
 * cannot be skipped - resume first if needed. List with
 * q402_recurring_list to find the ruleId and inspect current state.
 *
 * Hits POST /api/wallet/agentic/recurring-by-key { action: "skip-next", ruleId }.
 */

import { z } from "zod";
import { CONFIG } from "../config.js";

export const RecurringSkipNextInputSchema = z.object({
  ruleId: z
    .string()
    .min(1)
    .describe(
      "Rule id whose next scheduled fire to skip. Obtain from " +
        "q402_recurring_list - each entry's `ruleId` field.",
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
export type RecurringSkipNextInput = z.infer<typeof RecurringSkipNextInputSchema>;

export const RECURRING_SKIP_NEXT_TOOL = {
  name: "q402_recurring_skip_next",
  description:
    "Skip ONLY the next scheduled fire of a recurring-payment rule. " +
    "Cadence is preserved - the fire after the skipped one runs normally. " +
    "Use this when the user says 'skip the next Friday payout, Alice is " +
    "on holiday' or 'don't fire this month's subscription, charge it next " +
    "month'. The rule must be in active status; paused / cancelled rules " +
    "must be resumed first. Authenticated by the paid Multichain API key. " +
    "Call q402_recurring_list first to confirm the ruleId and current " +
    "schedule.",
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
  nextRunAt: number;
}

export interface RecurringSkipNextResult {
  ok:           boolean;
  walletId:     string | null;
  rule:         RuleSummary | null;
  error?:       string;
  message?:     string;
  dashboardUrl: string;
}

export async function runRecurringSkipNext(
  input: RecurringSkipNextInput,
): Promise<RecurringSkipNextResult> {
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
        action: "skip-next",
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
        message:      data.message ?? `Skip-next failed with HTTP ${res.status}.`,
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
