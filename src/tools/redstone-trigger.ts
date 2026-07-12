/**
 * RedStone data-event trigger tools - the "pay when a NAV / price feed crosses a
 * threshold" surface for Agent Wallets.
 *
 *   q402_redstone_feeds          no-key. Which feeds are readable + is the
 *                                feature enabled on this deployment.
 *   q402_redstone_trigger_create Mode C, confirm-gated. Arm a gasless payout on
 *                                a RedStone feed crossing.
 *   q402_redstone_trigger_list   Mode C. List the wallet's triggers.
 *   q402_redstone_trigger_cancel Mode C. Permanently stop a trigger.
 *
 * A trigger fires EXACTLY ONCE per rising-edge crossing (edge-latch, server-
 * side): it will not re-fire on a level that stays breached, and a trigger
 * created while the feed is already past the threshold does NOT instant-fire -
 * it arms on the next unmet observation and fires on the next crossing. Each
 * fire is bounded by the wallet's perTxMax + dailyLimit, same as recurring.
 *
 * All write tools hit POST /api/wallet/agentic/redstone-trigger-by-key.
 * The feature is OFF by default server-side (REDSTONE_ENABLED) - the create/
 * list/cancel calls return REDSTONE_DISABLED (503) until an operator enables it.
 */

import { z } from "zod";
import { CONFIG } from "../config.js";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const AMOUNT_RE = /^\d+(\.\d{1,18})?$/;
const CHAINS = [
  "bnb", "eth", "avax", "xlayer", "mantle", "injective",
  "monad", "scroll", "stable", "arbitrum", "base", "robinhood",
] as const;

function dashboardUrl(): string {
  return CONFIG.relayBaseUrl.replace(/\/api$/, "") + "/dashboard?tab=agent";
}

// -- q402_redstone_feeds (no key) ---------------------------------------------

export const RedstoneFeedsInputSchema = z.object({});
export type RedstoneFeedsInput = z.infer<typeof RedstoneFeedsInputSchema>;

export const REDSTONE_FEEDS_TOOL = {
  name: "q402_redstone_feeds",
  description:
    "Discover which RedStone feeds this deployment can drive triggers off, and " +
    "whether the RedStone-trigger feature is enabled. No API key required. Call " +
    "this before q402_redstone_trigger_create so you pick a feedId the server " +
    "can actually read - a trigger on a non-allowlisted feed is rejected. " +
    "Returns { enabled, allowedFeeds, dataServiceId }.",
  inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
};

export interface RedstoneFeedsResult {
  ok: boolean;
  enabled: boolean;
  allowedFeeds: string[];
  dataServiceId: string | null;
  message?: string;
}

export async function runRedstoneFeeds(): Promise<RedstoneFeedsResult> {
  const base = CONFIG.relayBaseUrl;
  try {
    const res = await fetch(`${base}/redstone/feeds`, { method: "GET" });
    const data = (await res.json().catch(() => ({}))) as {
      enabled?: boolean;
      allowedFeeds?: string[];
      dataServiceId?: string;
    };
    if (!res.ok) {
      return { ok: false, enabled: false, allowedFeeds: [], dataServiceId: null, message: `HTTP ${res.status}` };
    }
    return {
      ok: true,
      enabled: Boolean(data.enabled),
      allowedFeeds: Array.isArray(data.allowedFeeds) ? data.allowedFeeds : [],
      dataServiceId: data.dataServiceId ?? null,
      ...(data.enabled ? {} : { message: "RedStone triggers are not enabled on this deployment yet." }),
    };
  } catch (e) {
    return {
      ok: false,
      enabled: false,
      allowedFeeds: [],
      dataServiceId: null,
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

// -- q402_redstone_trigger_create (Mode C, confirm-gated) ---------------------

export const RedstoneTriggerCreateInputSchema = z.object({
  confirm: z
    .literal(true)
    .describe(
      "REQUIRED. Must be literally `true`. A trigger arms a FUTURE on-chain " +
        "payout the user does not click through when it fires - echo back the " +
        "feed + op + threshold + recipient + amount + chain + token you intend, " +
        "get an explicit user yes, and ONLY then call with confirm: true. Same " +
        "guard q402_pay / q402_recurring_create use.",
    ),
  feedId: z
    .string()
    .min(1)
    .describe('RedStone feed id to watch (e.g. "ETH", "BTC"). Must be in q402_redstone_feeds.allowedFeeds.'),
  op: z
    .enum([">=", "<=", ">", "<"])
    .describe('Comparison against threshold. ">=" / ">" fire when the feed rises to/past it; "<=" / "<" when it falls to/past it.'),
  threshold: z
    .number()
    .describe("The feed value to cross. Same unit the feed reports (e.g. USD price / NAV)."),
  recipient: z.string().regex(ADDRESS_RE).describe("0x-prefixed 20-byte payout recipient. Required."),
  amount: z
    .string()
    .regex(AMOUNT_RE)
    .describe('Payout amount as a decimal string (e.g. "100.0"). Same unit as `token` (USD-1 stablecoin).'),
  chain: z.enum(CHAINS).default("bnb").describe("Chain to fire the payout on. Defaults to bnb. Paid Multichain subscription required."),
  token: z.enum(["USDC", "USDT", "USDG"]).default("USDT").describe("Stablecoin to send. USDG is Robinhood-Chain-only."),
  mode: z
    .enum(["once", "repeat"])
    .default("once")
    .describe('"once" fires a single time then stops. "repeat" re-arms after the feed returns to the unmet side and can fire again (subject to cooldownSec).'),
  cooldownSec: z
    .number()
    .min(0)
    .optional()
    .describe("repeat mode only: minimum seconds between fires. Defaults to 0."),
  label: z.string().max(64).optional().describe("Optional human label (≤64 chars)."),
  walletId: z.string().optional().describe("Optional Agent Wallet address for multi-wallet owners. Defaults to the server default wallet."),
});
export type RedstoneTriggerCreateInput = z.infer<typeof RedstoneTriggerCreateInputSchema>;

export const REDSTONE_TRIGGER_CREATE_TOOL = {
  name: "q402_redstone_trigger_create",
  description:
    "Arm a gasless payout that fires when a RedStone feed (NAV / price / RWA) " +
    "crosses a threshold - e.g. \"when ETH >= 2000, send 100 USDT to 0x…\", or " +
    "\"when the fund NAV drops to <= 0.98, send the redemption\". Fires EXACTLY " +
    "ONCE per rising-edge crossing (edge-latched server-side): it will not " +
    "re-fire while the level stays breached, and a trigger created while the " +
    "feed is already past the threshold does NOT instant-fire - it waits for the " +
    "next real crossing. Authenticated by the Multichain API key; no private key. " +
    "Requires the paid Multichain subscription (trial keys rejected). Each fire " +
    "is bounded by the wallet's perTxMax + dailyLimit and your local " +
    "Q402_MAX_AMOUNT_PER_CALL + Q402_ALLOWED_RECIPIENTS rails. Call " +
    "q402_redstone_feeds first to pick a readable feedId. Stop any time with " +
    "q402_redstone_trigger_cancel.",
  inputSchema: {
    type: "object" as const,
    properties: {
      confirm: {
        type: "boolean" as const,
        const: true,
        description:
          "REQUIRED. Must be literally `true`. Triggers arm future on-chain payouts " +
          "without a per-fire prompt, so get an explicit user yes BEFORE setting this.",
      },
      feedId: { type: "string" as const, description: 'Required. RedStone feed id (e.g. "ETH"). Must be allowlisted (see q402_redstone_feeds).' },
      op: { type: "string" as const, enum: [">=", "<=", ">", "<"], description: "Required. Comparison against threshold." },
      threshold: { type: "number" as const, description: "Required. Feed value to cross." },
      recipient: { type: "string" as const, pattern: "^0x[0-9a-fA-F]{40}$", description: "Required. 0x payout recipient." },
      amount: { type: "string" as const, pattern: "^\\d+(\\.\\d{1,18})?$", description: 'Required. Payout amount as decimal string (e.g. "100.0").' },
      chain: { type: "string" as const, enum: [...CHAINS], description: "Default 'bnb'. Paid Multichain subscription required." },
      token: { type: "string" as const, enum: ["USDC", "USDT", "USDG"], description: "Default 'USDT'. USDG is Robinhood-Chain-only." },
      mode: { type: "string" as const, enum: ["once", "repeat"], description: "Default 'once'. 'repeat' re-arms after the feed goes back to the unmet side." },
      cooldownSec: { type: "number" as const, minimum: 0, description: "repeat only: min seconds between fires. Default 0." },
      label: { type: "string" as const, maxLength: 64, description: "Optional human label." },
      walletId: { type: "string" as const, description: "Optional. Defaults to server default wallet." },
    },
    required: ["confirm", "feedId", "op", "threshold", "recipient", "amount"],
    additionalProperties: false,
  },
};

interface TriggerSummary {
  id: string;
  walletId: string;
  status: string;
  feedId: string;
  op: string;
  threshold: number;
  chain: string;
  token: string;
  recipient: string;
  amount: string;
  mode: string;
  armed: boolean;
  createdAt: number;
}

export interface RedstoneTriggerCreateResult {
  ok: boolean;
  walletId: string | null;
  trigger: TriggerSummary | null;
  error?: string;
  message?: string;
  dashboardUrl: string;
}

export async function runRedstoneTriggerCreate(
  input: RedstoneTriggerCreateInput,
): Promise<RedstoneTriggerCreateResult> {
  const base = CONFIG.relayBaseUrl;
  const dash = dashboardUrl();

  if (!CONFIG.apiKey || !CONFIG.apiKey.startsWith("q402_live_")) {
    return { ok: false, walletId: null, trigger: null, error: "API_KEY_REQUIRED", message: "No live Q402 API key configured. Run q402_doctor.", dashboardUrl: dash };
  }
  if (!CONFIG.multichainApiKey || !CONFIG.multichainApiKey.startsWith("q402_live_")) {
    return {
      ok: false,
      walletId: null,
      trigger: null,
      error: "MULTICHAIN_KEY_REQUIRED",
      message:
        "RedStone triggers require a paid Multichain API key (Q402_MULTICHAIN_API_KEY). " +
        "Activate a paid plan at https://q402.quackai.ai/payment.",
      dashboardUrl: dash,
    };
  }

  // Same client-side rails as q402_pay / q402_recurring_create - a trigger fires
  // a future send the user won't click through, so (recipient, amount) must
  // clear the per-call cap + recipient allowlist.
  const amountNum = Number(input.amount);
  if (Number.isFinite(amountNum) && amountNum > CONFIG.maxAmountPerCallUsd) {
    return {
      ok: false,
      walletId: null,
      trigger: null,
      error: "AMOUNT_EXCEEDS_CAP",
      message: `Payout $${input.amount} exceeds your Q402_MAX_AMOUNT_PER_CALL cap of $${CONFIG.maxAmountPerCallUsd}.`,
      dashboardUrl: dash,
    };
  }
  if (CONFIG.allowedRecipients.length > 0 && !CONFIG.allowedRecipients.includes(input.recipient.toLowerCase())) {
    return {
      ok: false,
      walletId: null,
      trigger: null,
      error: "RECIPIENT_NOT_ALLOWED",
      message: `Recipient ${input.recipient} is not in Q402_ALLOWED_RECIPIENTS.`,
      dashboardUrl: dash,
    };
  }

  const explicitWalletId =
    typeof input.walletId === "string" && input.walletId.length > 0 ? input.walletId.toLowerCase() : CONFIG.walletId;

  try {
    const res = await fetch(`${base}/wallet/agentic/redstone-trigger-by-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: CONFIG.apiKey,
        action: "create",
        feedId: input.feedId,
        op: input.op,
        threshold: input.threshold,
        recipient: input.recipient.toLowerCase(),
        amount: input.amount,
        chain: input.chain ?? "bnb",
        token: input.token ?? "USDT",
        mode: input.mode ?? "once",
        ...(input.cooldownSec !== undefined ? { cooldownSec: input.cooldownSec } : {}),
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(explicitWalletId ? { walletId: explicitWalletId } : {}),
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      walletId?: string;
      trigger?: TriggerSummary;
      error?: string;
      message?: string;
    };
    if (!res.ok) {
      return {
        ok: false,
        walletId: explicitWalletId,
        trigger: null,
        error: data.error ?? `HTTP_${res.status}`,
        message: data.message ?? `Create failed with HTTP ${res.status}.`,
        dashboardUrl: dash,
      };
    }
    return { ok: true, walletId: data.walletId ?? explicitWalletId, trigger: data.trigger ?? null, dashboardUrl: dash };
  } catch (e) {
    return { ok: false, walletId: explicitWalletId, trigger: null, error: "NETWORK_ERROR", message: e instanceof Error ? e.message : String(e), dashboardUrl: dash };
  }
}

// -- q402_redstone_trigger_list (Mode C) --------------------------------------

export const RedstoneTriggerListInputSchema = z.object({
  walletId: z.string().optional().describe("Optional Agent Wallet address for multi-wallet owners."),
});
export type RedstoneTriggerListInput = z.infer<typeof RedstoneTriggerListInputSchema>;

export const REDSTONE_TRIGGER_LIST_TOOL = {
  name: "q402_redstone_trigger_list",
  description:
    "List the RedStone triggers on the user's Agent Wallet - each with its feed, " +
    "condition (op + threshold), recipient, amount, mode, armed state, and " +
    "fire history. Authenticated by the Multichain API key; no funds move.",
  inputSchema: {
    type: "object" as const,
    properties: { walletId: { type: "string" as const, description: "Optional. Defaults to server default wallet." } },
    additionalProperties: false,
  },
};

export interface RedstoneTriggerListResult {
  ok: boolean;
  walletId: string | null;
  triggers: TriggerSummary[];
  count: number;
  error?: string;
  message?: string;
}

export async function runRedstoneTriggerList(
  input: RedstoneTriggerListInput,
): Promise<RedstoneTriggerListResult> {
  const base = CONFIG.relayBaseUrl;
  if (!CONFIG.apiKey || !CONFIG.apiKey.startsWith("q402_live_")) {
    return { ok: false, walletId: null, triggers: [], count: 0, error: "API_KEY_REQUIRED", message: "No live Q402 API key configured. Run q402_doctor." };
  }
  const explicitWalletId =
    typeof input.walletId === "string" && input.walletId.length > 0 ? input.walletId.toLowerCase() : CONFIG.walletId;
  try {
    const res = await fetch(`${base}/wallet/agentic/redstone-trigger-by-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: CONFIG.apiKey, action: "list", ...(explicitWalletId ? { walletId: explicitWalletId } : {}) }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      walletId?: string;
      triggers?: TriggerSummary[];
      count?: number;
      error?: string;
      message?: string;
    };
    if (!res.ok) {
      return { ok: false, walletId: explicitWalletId, triggers: [], count: 0, error: data.error ?? `HTTP_${res.status}`, message: data.message };
    }
    return { ok: true, walletId: data.walletId ?? explicitWalletId, triggers: data.triggers ?? [], count: data.count ?? (data.triggers?.length ?? 0) };
  } catch (e) {
    return { ok: false, walletId: explicitWalletId, triggers: [], count: 0, error: "NETWORK_ERROR", message: e instanceof Error ? e.message : String(e) };
  }
}

// -- q402_redstone_trigger_cancel (Mode C) ------------------------------------

export const RedstoneTriggerCancelInputSchema = z.object({
  triggerId: z.string().min(1).describe("The trigger id to permanently cancel (from q402_redstone_trigger_list)."),
  walletId: z.string().optional().describe("Optional Agent Wallet address for multi-wallet owners."),
});
export type RedstoneTriggerCancelInput = z.infer<typeof RedstoneTriggerCancelInputSchema>;

export const REDSTONE_TRIGGER_CANCEL_TOOL = {
  name: "q402_redstone_trigger_cancel",
  description:
    "Permanently cancel a RedStone trigger so it never fires again. " +
    "Authenticated by the Multichain API key. Use q402_redstone_trigger_list to " +
    "find the triggerId.",
  inputSchema: {
    type: "object" as const,
    properties: {
      triggerId: { type: "string" as const, description: "Required. The trigger id to cancel." },
      walletId: { type: "string" as const, description: "Optional. Defaults to server default wallet." },
    },
    required: ["triggerId"],
    additionalProperties: false,
  },
};

export interface RedstoneTriggerCancelResult {
  ok: boolean;
  walletId: string | null;
  trigger: TriggerSummary | null;
  error?: string;
  message?: string;
}

export async function runRedstoneTriggerCancel(
  input: RedstoneTriggerCancelInput,
): Promise<RedstoneTriggerCancelResult> {
  const base = CONFIG.relayBaseUrl;
  if (!CONFIG.apiKey || !CONFIG.apiKey.startsWith("q402_live_")) {
    return { ok: false, walletId: null, trigger: null, error: "API_KEY_REQUIRED", message: "No live Q402 API key configured. Run q402_doctor." };
  }
  const explicitWalletId =
    typeof input.walletId === "string" && input.walletId.length > 0 ? input.walletId.toLowerCase() : CONFIG.walletId;
  try {
    const res = await fetch(`${base}/wallet/agentic/redstone-trigger-by-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: CONFIG.apiKey, action: "cancel", triggerId: input.triggerId, ...(explicitWalletId ? { walletId: explicitWalletId } : {}) }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      walletId?: string;
      trigger?: TriggerSummary;
      error?: string;
      message?: string;
    };
    if (!res.ok) {
      return { ok: false, walletId: explicitWalletId, trigger: null, error: data.error ?? `HTTP_${res.status}`, message: data.message };
    }
    return { ok: true, walletId: data.walletId ?? explicitWalletId, trigger: data.trigger ?? null };
  } catch (e) {
    return { ok: false, walletId: explicitWalletId, trigger: null, error: "NETWORK_ERROR", message: e instanceof Error ? e.message : String(e) };
  }
}
