/**
 * q402_recurring_create — author a new recurring-payment rule on the
 * Agent Wallet.
 *
 * Mode-C-only (apiKey auth). Single-recipient — for multi-recipient
 * payroll rules the user opens the dashboard. The recurring scheduler
 * itself handles cancel-window alerts, daily/per-tx cap enforcement,
 * and the hourly heartbeat that drives every cadence (see
 * recurring-trigger in the viz-backend).
 *
 * Frequency strings (validated server-side):
 *   "hourly:N"      where N is 1..23. Fires every N hours.
 *   "daily"         once per day at the creation-minute UTC.
 *   "weekly:{day}"  day in {mon,tue,wed,thu,fri,sat,sun}.
 *   "monthly:N"     day-of-month 1..31 (fires last day if shorter).
 *   "monthly:last"  last day of every month.
 *
 * Non-BNB chains require the paid Multichain subscription. Trial
 * Mode-C calls on bnb still work.
 *
 * Hits POST /api/wallet/agentic/recurring-by-key { action: "create", ... }.
 */

import { z } from "zod";
import { CONFIG } from "../config.js";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const AMOUNT_RE = /^\d+(\.\d{1,18})?$/;

export const RecurringCreateInputSchema = z.object({
  confirm: z
    .literal(true)
    .describe(
      "REQUIRED. Must be literally `true`. Authoring a recurring rule schedules " +
        "future on-chain payments that the user does not click through one-by-one — " +
        "the user has to explicitly say yes BEFORE this is called. Echo back the " +
        "frequency + recipient + amount + chain + token + cancelWindow you intend " +
        "to create, get a plain-language confirmation from the user (e.g. \"yes, " +
        "create the schedule\"), and ONLY then call this with confirm: true. " +
        "Mirrors the same guard q402_pay / q402_batch_pay use on one-shot sends.",
    ),
  frequency: z
    .string()
    .min(1)
    .describe(
      'Cadence string. One of: "hourly:N" (N=1..23), "daily", ' +
        '"weekly:{mon|tue|wed|thu|fri|sat|sun}", "monthly:N" (N=1..31), ' +
        '"monthly:last". Examples: "hourly:1" fires every hour, ' +
        '"weekly:fri" fires every Friday, "monthly:1" fires on the 1st of each month.',
    ),
  recipient: z
    .string()
    .regex(ADDRESS_RE)
    .describe("0x-prefixed 20-byte recipient address. Required."),
  amount: z
    .string()
    .regex(AMOUNT_RE)
    .describe(
      "Amount per fire, as a decimal string (e.g. \"1.5\", \"0.0001\"). " +
        "Counted in the same unit as `token` (USDC or USDT, both 1:1 USD).",
    ),
  chain: z
    .enum(["bnb", "eth", "avax", "xlayer", "mantle", "injective", "monad", "scroll", "stable"])
    .default("bnb")
    .describe(
      "Chain to fire the recurring TX on. Defaults to bnb (the only chain " +
        "supported on Trial). Non-bnb requires the paid Multichain subscription.",
    ),
  token: z
    .enum(["USDC", "USDT"])
    .default("USDT")
    .describe("Stablecoin to send. USDC or USDT. Both peg to USD-1."),
  label: z
    .string()
    .max(64)
    .optional()
    .describe('Optional human-readable label (≤64 chars). Shows up in q402_recurring_list and the dashboard.'),
  cancelWindowHours: z
    .number()
    .min(0)
    .optional()
    .describe(
      "Hours of advance notice before each fire during which the rule can " +
        "be cancelled. 0 = fire immediately at the next slot, no alert. " +
        "Capped at the cadence interval (e.g. ≤ N-0.5h for hourly:N, ≤24 for daily). " +
        "Defaults to 0.",
    ),
  walletId: z
    .string()
    .optional()
    .describe(
      "Optional lowercased Agent Wallet address when the user holds multiple " +
        "wallets. Defaults to Q402_AGENT_WALLET_ADDRESS env, then the owner's " +
        "default wallet on the server.",
    ),
});
export type RecurringCreateInput = z.infer<typeof RecurringCreateInputSchema>;

export const RECURRING_CREATE_TOOL = {
  name: "q402_recurring_create",
  description:
    "Author a new recurring-payment rule on the user's Agent Wallet. Single-" +
    "recipient (use the dashboard for multi-recipient payroll). Pick a " +
    "cadence — hourly:N, daily, weekly:{day}, monthly:N, or monthly:last — " +
    "and a recipient + amount + chain + token. Authenticated by the " +
    "configured Multichain API key; no private key required. Non-bnb chains " +
    "need the paid Multichain subscription. Each fire is bounded by the " +
    "wallet's perTxMax (configured on the dashboard) — the dashboard's " +
    "dailyLimit cap currently applies to manual sends only, NOT recurring " +
    "fires, so an attacker with the apiKey could schedule N rules at " +
    "perTxMax and drain the wallet's USDC balance over time. The user can " +
    "stop a rule any time via q402_recurring_cancel.",
  inputSchema: {
    type: "object" as const,
    properties: {
      confirm: {
        type: "boolean" as const,
        const: true,
        description:
          "REQUIRED. Must be literally `true`. Recurring rules schedule future " +
          "on-chain payments without per-fire user prompts, so the agent must " +
          "get an explicit user yes BEFORE setting `confirm: true` and calling " +
          "this. Same guard q402_pay / q402_batch_pay use on one-shot sends.",
      },
      frequency: {
        type: "string" as const,
        description:
          'Required. "hourly:N" (N=1..23), "daily", "weekly:{day}", "monthly:N", or "monthly:last".',
      },
      recipient: {
        type: "string" as const,
        pattern: "^0x[0-9a-fA-F]{40}$",
        description: "Required. 0x-prefixed 20-byte recipient address.",
      },
      amount: {
        type: "string" as const,
        pattern: "^\\d+(\\.\\d{1,18})?$",
        description: "Required. Per-fire amount as decimal string (e.g. \"1.5\").",
      },
      chain: {
        type: "string" as const,
        enum: ["bnb", "eth", "avax", "xlayer", "mantle", "injective", "monad", "scroll", "stable"],
        description: "Default 'bnb'. Non-bnb requires paid Multichain.",
      },
      token: {
        type: "string" as const,
        enum: ["USDC", "USDT"],
        description: "Default 'USDT'. Both peg USD-1.",
      },
      label: {
        type: "string" as const,
        maxLength: 64,
        description: 'Optional human label (≤64 chars).',
      },
      cancelWindowHours: {
        type: "number" as const,
        minimum: 0,
        description:
          "Optional advance-notice window in hours. 0 = no alert, fires at " +
          "the next slot. Defaults to 0.",
      },
      walletId: {
        type: "string" as const,
        description: "Optional. Defaults to default wallet on server.",
      },
    },
    required: ["confirm", "frequency", "recipient", "amount"],
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
}

export interface RecurringCreateResult {
  ok:           boolean;
  walletId:     string | null;
  rule:         RuleSummary | null;
  error?:       string;
  message?:     string;
  dashboardUrl: string;
}

export async function runRecurringCreate(
  input: RecurringCreateInput,
): Promise<RecurringCreateResult> {
  const base = CONFIG.relayBaseUrl;
  const dashboardUrl = base.replace(/\/api$/, "") + "/dashboard?tab=agent";

  if (!CONFIG.apiKey || !CONFIG.apiKey.startsWith("q402_live_")) {
    return {
      ok:           false,
      walletId:     null,
      rule:         null,
      error:        "API_KEY_REQUIRED",
      message:      "No live Q402 API key configured. Run q402_doctor to set one up.",
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
        apiKey:    CONFIG.apiKey,
        action:    "create",
        frequency: input.frequency,
        recipient: input.recipient.toLowerCase(),
        amount:    input.amount,
        chain:     input.chain ?? "bnb",
        token:     input.token ?? "USDT",
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.cancelWindowHours !== undefined ? { cancelWindowHours: input.cancelWindowHours } : {}),
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
        message:      data.message ?? `Create failed with HTTP ${res.status}.`,
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
