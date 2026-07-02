/**
 * q402_recurring_create — author a new recurring-payment rule on the
 * Agent Wallet.
 *
 * Mode-C-only (apiKey auth). Single-recipient — for multi-recipient
 * payroll rules the user opens the dashboard. The recurring scheduler
 * itself handles cancel-window alerts and the hourly heartbeat that
 * drives every cadence. Each fire is gated server-side by BOTH the
 * wallet's `perTxMaxUsd` (per-fire cap) AND its `dailyLimitUsd`: the
 * rule's daily total reserves against the same daily bucket as manual
 * sends (a 2026-06-10 fix — the cron skips the fire if the bucket can't
 * cover it), so scheduled rules can't outrun the dashboard caps. This
 * tool additionally applies the client-side Q402_MAX_AMOUNT_PER_CALL +
 * Q402_ALLOWED_RECIPIENTS rails to (recipient, amount) at author time,
 * matching the one-shot q402_pay / q402_batch_pay guards.
 *
 * Frequency strings (validated server-side):
 *   "hourly:N"      N=1..23. Fires every N hours, snapped to the next
 *                    :00 UTC after the cancel window.
 *   "daily"         once per day at the creation-minute UTC.
 *   "weekly:{day}"  day in {mon,tue,wed,thu,fri,sat,sun}.
 *   "monthly:N"     day-of-month 1..31 (fires last day if shorter).
 *   "monthly:last"  last day of every month.
 *
 * Recurring is a paid feature on EVERY chain, including BNB. Trial keys
 * are rejected at create time with `MULTICHAIN_REQUIRED` even when the
 * user picks `chain: "bnb"` — trial keys can still pay manually via
 * `q402_pay`, but scheduled fires consume paid-tier quota and require
 * the live Multichain subscription.
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
    .enum(["bnb", "eth", "avax", "xlayer", "mantle", "injective", "monad", "scroll", "stable", "arbitrum", "base", "robinhood"])
    .default("bnb")
    .describe(
      "Chain to fire the recurring TX on. Defaults to bnb. " +
        "Recurring requires the paid Multichain subscription on EVERY chain, " +
        "including bnb — Trial keys are rejected at create time with " +
        "MULTICHAIN_REQUIRED. Trial keys can still pay one-shot via q402_pay on BNB.",
    ),
  token: z
    .enum(["USDC", "USDT", "USDG"])
    .default("USDT")
    .describe("Stablecoin to send. USDC / USDT on most chains; USDG (Paxos Global Dollar) is Robinhood-Chain-only. All peg to USD-1."),
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
    "configured Multichain API key; no private key required. Recurring " +
    "requires the paid Multichain subscription on EVERY chain including " +
    "bnb — trial keys are rejected at create time with MULTICHAIN_REQUIRED " +
    "and should keep using q402_pay for one-shot Trial sends. Each fire is " +
    "bounded server-side by BOTH the wallet's perTxMax AND its dailyLimit — a " +
    "rule's daily total reserves against the same daily bucket as manual sends " +
    "(the scheduler skips the fire if the bucket can't cover it), so scheduled " +
    "rules can't outrun the dashboard caps. This tool also enforces your local " +
    "Q402_MAX_AMOUNT_PER_CALL + Q402_ALLOWED_RECIPIENTS rails at create time. " +
    "The user can stop a rule any time via q402_recurring_cancel.",
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
        enum: ["bnb", "eth", "avax", "xlayer", "mantle", "injective", "monad", "scroll", "stable", "arbitrum", "base", "robinhood"],
        description: "Default 'bnb'. Recurring requires the paid Multichain subscription on EVERY chain (BNB included) — trial keys are rejected with MULTICHAIN_REQUIRED.",
      },
      token: {
        type: "string" as const,
        enum: ["USDC", "USDT", "USDG"],
        description: "Default 'USDT'. USDG (Paxos Global Dollar) is Robinhood-Chain-only. All peg USD-1.",
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
  // Recurring schedules are Multichain-only on the server. The Trial
  // key never satisfies the recurring scope check, so failing locally
  // here saves a roundtrip + gives the user an actionable hint instead
  // of an opaque server-side scope error.
  if (!CONFIG.multichainApiKey || !CONFIG.multichainApiKey.startsWith("q402_live_")) {
    return {
      ok:       false,
      walletId: null,
      rule:     null,
      error:    "MULTICHAIN_KEY_REQUIRED",
      message:
        "Recurring payments require a paid Multichain API key " +
        "(Q402_MULTICHAIN_API_KEY). Trial keys can't schedule recurring " +
        "rules. Activate a paid plan at https://q402.quackai.ai/payment.",
      dashboardUrl,
    };
  }

  // F10: apply the SAME client-side rails q402_pay / q402_batch_pay apply.
  // A recurring rule schedules future sends the user won't click through
  // one-by-one, so each fire's (recipient, amount) must clear the per-call
  // amount cap and the recipient allowlist the user configured — otherwise
  // an agent could schedule payouts above the cap or to an off-allowlist
  // address that the one-shot tools would have refused.
  const amountNum = Number(input.amount);
  if (Number.isFinite(amountNum) && amountNum > CONFIG.maxAmountPerCallUsd) {
    return {
      ok:       false,
      walletId: null,
      rule:     null,
      error:    "AMOUNT_EXCEEDS_CAP",
      message:
        `Per-fire amount $${input.amount} exceeds your Q402_MAX_AMOUNT_PER_CALL cap of ` +
        `$${CONFIG.maxAmountPerCallUsd}. Each recurring fire is bounded by the same per-call ` +
        `cap as a one-shot q402_pay — raise the cap if this schedule is intentional.`,
      dashboardUrl,
    };
  }
  if (
    CONFIG.allowedRecipients.length > 0 &&
    !CONFIG.allowedRecipients.includes(input.recipient.toLowerCase())
  ) {
    return {
      ok:       false,
      walletId: null,
      rule:     null,
      error:    "RECIPIENT_NOT_ALLOWED",
      message:
        `Recipient ${input.recipient} is not in Q402_ALLOWED_RECIPIENTS. A recurring rule would ` +
        `send to it on every fire — add it to the allowlist or unset the env var to disable the guard.`,
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
