/**
 * q402_recurring_list — list the Agent Wallet's recurring-payment rules.
 *
 * Mode-C-only: the configured Multichain API key authenticates the call.
 * No private key required. Returns the same rule shape the dashboard
 * uses (status, frequency, next-run timestamp, fired count, last
 * error) so the AI can describe the schedule back to the user.
 *
 * Read-only — does not create, modify, or cancel rules. Use
 * `q402_recurring_create` to author and `q402_recurring_cancel` to stop.
 *
 * Hits POST /api/wallet/agentic/recurring-by-key { action: "list" }.
 */

import { z } from "zod";
import { CONFIG } from "../config.js";

export const RecurringListInputSchema = z.object({
  walletId: z
    .string()
    .optional()
    .describe(
      "Optional lowercased Agent Wallet address to list rules for when the " +
        "user holds multiple wallets. Omit to use Q402_AGENT_WALLET_ADDRESS env, " +
        "then the owner's default wallet.",
    ),
});
export type RecurringListInput = z.infer<typeof RecurringListInputSchema>;

export const RECURRING_LIST_TOOL = {
  name: "q402_recurring_list",
  description:
    "Read the user's active recurring-payment rules on their Agent Wallet. " +
    "Returns each rule's ruleId, label, frequency (hourly:N / daily / weekly:{day} / " +
    "monthly:N / monthly:last), recipient + amount, chain, token, status (active / " +
    "paused / paused-by-archive / fired-cap-exceeded / cancelled), when the next " +
    "fire is scheduled, how many fires have completed, and the most recent error " +
    "(if any). Use this when the user asks 'what scheduled payouts do I have?' or " +
    "before authoring a new rule with q402_recurring_create. Authenticated by the " +
    "configured Multichain API key — no private key required.",
  inputSchema: {
    type: "object" as const,
    properties: {
      walletId: {
        type: "string" as const,
        description:
          "Optional. Lowercased Agent Wallet address when the user holds multiple " +
          "wallets. Defaults to Q402_AGENT_WALLET_ADDRESS env, then the owner's " +
          "default wallet on the server.",
      },
    },
    additionalProperties: false,
  },
};

interface RuleSummary {
  ruleId:            string;
  walletId:          string;
  label:             string | null;
  status:            string;
  frequency:         string;
  chain:             string;
  token:             string;
  recipients:        Array<{ to: string; amount: string }>;
  cancelWindowHours: number;
  createdAt:         number;
  nextRunAt:         number;
  firedCount:        number;
  lastFiredAt:       number | null;
  lastError:         string | null;
}

export interface RecurringListResult {
  configured: boolean;
  walletId:   string | null;
  rules:      RuleSummary[];
  count:      number;
  setupHint?: string;
  dashboardUrl: string;
}

export async function runRecurringList(
  input: RecurringListInput = {},
): Promise<RecurringListResult> {
  const base = CONFIG.relayBaseUrl;
  const dashboardUrl = base.replace(/\/api$/, "") + "/dashboard?tab=agent";

  if (!CONFIG.apiKey || !CONFIG.apiKey.startsWith("q402_live_")) {
    return {
      configured: false,
      walletId:   null,
      rules:      [],
      count:      0,
      dashboardUrl,
      setupHint:
        "No live Q402 API key configured. Run q402_doctor to set one up, " +
        "or open the dashboard to create rules from the UI.",
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
        action: "list",
        ...(explicitWalletId ? { walletId: explicitWalletId } : {}),
      }),
    });
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      return {
        configured: true,
        walletId:   explicitWalletId,
        rules:      [],
        count:      0,
        dashboardUrl,
        setupHint:
          `recurring-list failed: ${errBody.error ?? `HTTP ${res.status}`}` +
          (errBody.message ? ` — ${errBody.message}` : ""),
      };
    }
    const data = (await res.json()) as { walletId: string; rules: RuleSummary[]; count: number };
    return {
      configured: true,
      walletId:   data.walletId,
      rules:      data.rules,
      count:      data.count,
      dashboardUrl,
    };
  } catch (e) {
    return {
      configured: true,
      walletId:   explicitWalletId,
      rules:      [],
      count:      0,
      dashboardUrl,
      setupHint:  `recurring-list network error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
