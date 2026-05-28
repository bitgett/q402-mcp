/**
 * q402_recurring_cancel — stop a recurring-payment rule on the Agent Wallet.
 *
 * Mode-C-only (apiKey auth). Cancels a rule by ruleId — no advance
 * notice required, the cancel is immediate. The rule transitions to
 * the `cancelled` status; a future re-author of the same recipient
 * + frequency would create a fresh rule, not resurrect the old one.
 *
 * Use this when the user says "stop my weekly payout to Alice" — list
 * first with q402_recurring_list to find the matching ruleId, then
 * cancel.
 *
 * Hits POST /api/wallet/agentic/recurring-by-key { action: "cancel", ruleId }.
 */

import { z } from "zod";
import { CONFIG } from "../config.js";

export const RecurringCancelInputSchema = z.object({
  ruleId: z
    .string()
    .min(1)
    .describe(
      "Rule id to cancel. Obtain from q402_recurring_list — each entry's " +
        "`ruleId` field. Cancelling is immediate.",
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
export type RecurringCancelInput = z.infer<typeof RecurringCancelInputSchema>;

export const RECURRING_CANCEL_TOOL = {
  name: "q402_recurring_cancel",
  description:
    "Cancel an active recurring-payment rule on the Agent Wallet. Takes a " +
    "ruleId (from q402_recurring_list). Cancel is immediate — the rule will " +
    "not fire again. Authenticated by the configured Multichain API key. " +
    "Idempotent: cancelling an already-cancelled rule returns 409 with a " +
    "clear message. Use this whenever the user says 'stop my recurring " +
    "payment to X' — call q402_recurring_list first to find the matching " +
    "ruleId, then call this with that id.",
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

export interface RecurringCancelResult {
  ok:           boolean;
  walletId:     string | null;
  rule:         RuleSummary | null;
  error?:       string;
  message?:     string;
  dashboardUrl: string;
}

export async function runRecurringCancel(
  input: RecurringCancelInput,
): Promise<RecurringCancelResult> {
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
        action: "cancel",
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
        message:      data.message ?? `Cancel failed with HTTP ${res.status}.`,
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
