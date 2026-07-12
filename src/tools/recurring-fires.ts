/**
 * q402_recurring_fires - fetch the past-fire log for one recurring rule.
 *
 * Mode-C-only (apiKey auth). Returns up to the last 50 fires written by
 * the Q402 recurring cron after each successful settlement: when the
 * fire landed, the total amount that moved, the on-chain tx hashes, and
 * whether any recipient rows failed (partial-fire). Use this when the
 * user asks "did my weekly payout to Alice go out last Friday?" or
 * "how much has this rule spent so far this month?" - call
 * q402_recurring_list first to find the matching ruleId, then call
 * this with that id.
 *
 * Read-only - does NOT trigger a fire, modify the rule, or cancel
 * anything. Older fires beyond the 50-entry server cap drop off the
 * log; the on-chain history remains intact and can still be queried
 * from a block explorer using the rule's chain + recipient.
 *
 * Hits POST /api/wallet/agentic/recurring-by-key { action: "fires", ruleId, limit? }.
 */

import { z } from "zod";
import { CONFIG } from "../config.js";

export const RecurringFiresInputSchema = z.object({
  ruleId: z
    .string()
    .min(1)
    .describe(
      "Rule id whose fire history to fetch. Obtain from q402_recurring_list - " +
        "each entry's `ruleId` field.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe(
      "Max number of fires to return (newest first). Defaults to 50 (the server " +
        "cap). Pass a smaller number when you only need the most recent few.",
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
export type RecurringFiresInput = z.infer<typeof RecurringFiresInputSchema>;

export const RECURRING_FIRES_TOOL = {
  name: "q402_recurring_fires",
  description:
    "Read the past-fire history of a specific recurring-payment rule. " +
    "Returns up to 50 entries (newest first), each with the timestamp, " +
    "scheduled slot, total USD amount that settled, on-chain tx hashes, " +
    "and a partial-failure flag if some recipient rows didn't make it. " +
    "Use this when the user asks 'when was the last fire?', 'did Friday's " +
    "payout go out?', 'how much has rule X spent?', or before claiming a " +
    "fire is missing. Authenticated by the configured Multichain API key. " +
    "Read-only - does not trigger or modify anything. Call q402_recurring_list " +
    "first to find the ruleId.",
  inputSchema: {
    type: "object" as const,
    properties: {
      ruleId: {
        type: "string" as const,
        description: "Rule id from q402_recurring_list. Required.",
      },
      limit: {
        type: "number" as const,
        description: "Max number of fires to return (1-50, newest first). Defaults to 50.",
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
  label:     string | null;
  status:    string;
  frequency: string;
  chain:     string;
  token:     string;
}

interface FireEntry {
  /** Wall-clock time the fire was recorded (ms epoch UTC). */
  firedAt:            number;
  /** The scheduled slot this fire was paying for (ms epoch UTC). Equal
   *  to or slightly before `firedAt`. */
  slot:               number;
  /** Sum of all settled recipient amounts for this fire, USD-equivalent. */
  amountUsd:          number;
  /** On-chain tx hashes, one per recipient row that landed. */
  txHashes:           string[];
  /** Recipient rows that successfully settled on-chain. */
  settledCount:       number;
  /** Recipient rows that failed AFTER at least one settled (partial fire).
   *  All-rows-failed fires are NOT in this log - the rule didn't advance. */
  failedCount:        number;
  /** Human-readable partial-failure summary; null on clean fires. */
  partialFailureNote: string | null;
}

export interface RecurringFiresResult {
  configured:   boolean;
  walletId:     string | null;
  ruleId:       string;
  rule:         RuleSummary | null;
  fires:        FireEntry[];
  count:        number;
  dashboardUrl: string;
  error?:       string;
  message?:     string;
  setupHint?:   string;
}

export async function runRecurringFires(
  input: RecurringFiresInput,
): Promise<RecurringFiresResult> {
  const base = CONFIG.relayBaseUrl;
  const dashboardUrl = base.replace(/\/api$/, "") + "/dashboard?tab=agent";

  if (!CONFIG.apiKey || !CONFIG.apiKey.startsWith("q402_live_")) {
    return {
      configured:  false,
      walletId:    null,
      ruleId:      input.ruleId,
      rule:        null,
      fires:       [],
      count:       0,
      dashboardUrl,
      setupHint:
        "No live Q402 API key configured. Run q402_doctor to set one up, " +
        "or open the dashboard to view fire history from the UI.",
    };
  }
  if (!CONFIG.multichainApiKey || !CONFIG.multichainApiKey.startsWith("q402_live_")) {
    return {
      configured: false,
      walletId:   null,
      ruleId:     input.ruleId,
      rule:       null,
      fires:      [],
      count:      0,
      dashboardUrl,
      setupHint:
        "Recurring payments require a paid Multichain API key " +
        "(Q402_MULTICHAIN_API_KEY). Trial keys can't see fire history. " +
        "Activate a paid plan at https://q402.quackai.ai/payment.",
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
        action: "fires",
        ruleId: input.ruleId,
        ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
        ...(explicitWalletId ? { walletId: explicitWalletId } : {}),
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      walletId?: string;
      ruleId?:   string;
      rule?:     RuleSummary;
      fires?:    FireEntry[];
      count?:    number;
      error?:    string;
      message?:  string;
    };
    if (!res.ok) {
      return {
        configured:  true,
        walletId:    explicitWalletId,
        ruleId:      input.ruleId,
        rule:        null,
        fires:       [],
        count:       0,
        dashboardUrl,
        error:       data.error ?? `HTTP_${res.status}`,
        message:     data.message ?? `Fires fetch failed with HTTP ${res.status}.`,
      };
    }
    return {
      configured:  true,
      walletId:    data.walletId ?? explicitWalletId,
      ruleId:      data.ruleId   ?? input.ruleId,
      rule:        data.rule     ?? null,
      fires:       Array.isArray(data.fires) ? data.fires : [],
      count:       typeof data.count === "number" ? data.count : (data.fires?.length ?? 0),
      dashboardUrl,
    };
  } catch (e) {
    return {
      configured:  true,
      walletId:    explicitWalletId,
      ruleId:      input.ruleId,
      rule:        null,
      fires:       [],
      count:       0,
      dashboardUrl,
      error:       "NETWORK_ERROR",
      message:     e instanceof Error ? e.message : String(e),
    };
  }
}
