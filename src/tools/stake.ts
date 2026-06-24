/**
 * q402_stake / q402_unstake — WRITE / MOVES FUNDS. Gasless Q (QuackAI) token
 * staking into QuackAiStake on BNB (and unstaking back) from a server-managed
 * Agent Wallet (Mode C). The server holds the encrypted key, signs the
 * Stake/Unstake witness, and the relayer sponsors gas — the MCP never holds a
 * key for this path. Thin wrapper over POST /api/wallet/agentic/stake; the
 * server enforces a 15-min idempotency window keyed by (wallet,action,tier,
 * amount), so no idempotencyKey is needed here.
 *
 * Same two-phase consent + sandbox gate as q402_yield_deposit: MOVES FUNDS, so
 * it refuses to execute without confirm:true + a matching consentToken, and
 * needs a live Multichain key + Q402_ENABLE_REAL_PAYMENTS=1 for real funds.
 */

import { z } from "zod";
import { CONFIG, resolveApiKey } from "../config.js";
import { checkConsent } from "../consent.js";

/** Lock tiers (display only — the staking contract validates + reverts on an unknown tier). */
const STAKE_TIERS = [
  { stakeType: 0, lockDays: 14, aprPct: 10 },
  { stakeType: 1, lockDays: 30, aprPct: 20 },
  { stakeType: 2, lockDays: 90, aprPct: 30 },
  { stakeType: 3, lockDays: 140, aprPct: 40 },
  { stakeType: 4, lockDays: 120, aprPct: 50 },
  { stakeType: 5, lockDays: 180, aprPct: 30 },
] as const;
const TIER_VALUES = STAKE_TIERS.map((t) => t.stakeType);

// ── q402_stake ────────────────────────────────────────────────────────────

export const StakeInputSchema = z.object({
  amount: z
    .string()
    .regex(/^\d+(\.\d+)?$/, "amount must be a positive decimal string")
    .describe('Human-readable Q amount to stake, e.g. "1000".'),
  stakeType: z
    .number()
    .int()
    .refine((v) => TIER_VALUES.includes(v as (typeof TIER_VALUES)[number]), "unknown stakeType")
    .describe(
      "Lock tier: 0=14d/10% 1=30d/20% 2=90d/30% 3=140d/40% 4=120d/50% 5=180d/30% APR. " +
        "Longer lock = higher APR. Confirm the tier with the user.",
    ),
  walletId: z.string().optional().describe("Optional Agent Wallet address to stake from. Omit for the default."),
  confirm: z.boolean().optional().describe("MUST be true to actually stake. Omit to preview (no funds move)."),
  consentToken: z.string().optional().describe("Two-phase consent — leave unset to preview + get a token, then re-call with confirm:true + this token."),
});

export const STAKE_TOOL = {
  name: "q402_stake",
  description:
    "WRITE — MOVES FUNDS. Stakes the Agent Wallet's Q (QuackAI) token into QuackAiStake " +
    "on BNB Chain, gaslessly. Server-managed Agent Wallet path (Mode C): the server holds " +
    "the encrypted key, signs the stake, and sponsors gas. Pick a lock tier (stakeType 0-5): " +
    "0=14d/10%, 1=30d/20%, 2=90d/30%, 3=140d/40%, 4=120d/50%, 5=180d/30% APR — longer lock, " +
    "higher APR. Q is BNB-only. \n\n" +
    "REQUIRES CONFIRMATION — like q402_pay, refuses to execute unless confirm:true. Call FIRST " +
    "without confirm to preview (amount, tier, lock, wallet); show the user, get approval, THEN " +
    "re-call with confirm:true + the consentToken. \n\n" +
    "SANDBOX BY DEFAULT — no funds move unless a live Multichain key (q402_live_*) is configured " +
    "AND Q402_ENABLE_REAL_PAYMENTS=1. \n\n" +
    "RETRY SAFETY — on status=\"uncertain\" (broadcast unconfirmed) the stake MAY have settled; do " +
    "NOT blindly retry. The server dedupes identical (tier, amount) calls for 15 min, so a retry " +
    "within that window replays rather than double-stakes.",
  inputSchema: {
    type: "object" as const,
    properties: {
      amount: { type: "string" as const, description: 'Human-readable Q amount to stake, e.g. "1000".' },
      stakeType: { type: "number" as const, enum: TIER_VALUES as unknown as number[], description: "Lock tier 0-5 (0=14d/10% … 5=180d/30% APR). Longer lock = higher APR." },
      walletId: { type: "string" as const, description: "Optional Agent Wallet address to stake from. Defaults to the owner's default wallet." },
      confirm: { type: "boolean" as const, description: "MUST be true to actually stake — only after the user approved this exact stake. Omit to preview." },
      consentToken: { type: "string" as const, description: "Two-phase consent token. Leave unset on the first call to preview + get a token; re-call with confirm:true + this token." },
    },
    required: ["amount", "stakeType"],
    additionalProperties: false,
  },
};

// ── q402_unstake ──────────────────────────────────────────────────────────

export const UnstakeInputSchema = z.object({
  amount: z
    .string()
    .regex(/^\d+(\.\d+)?$/, "amount must be a positive decimal string")
    .describe('Human-readable Q amount to unstake (withdraw), e.g. "1000".'),
  walletId: z.string().optional().describe("Optional Agent Wallet address to unstake from. Omit for the default."),
  confirm: z.boolean().optional().describe("MUST be true to actually unstake. Omit to preview."),
  consentToken: z.string().optional().describe("Two-phase consent — leave unset to preview + get a token, then re-call with confirm:true + this token."),
});

export const UNSTAKE_TOOL = {
  name: "q402_unstake",
  description:
    "WRITE — MOVES FUNDS. Unstakes (withdraws) the Agent Wallet's Q from QuackAiStake on BNB " +
    "back to the wallet, gaslessly (Mode C, server-signed, relayer-sponsored gas). Reverts on-chain " +
    "if the lock period hasn't elapsed or the amount exceeds the staked position. \n\n" +
    "REQUIRES CONFIRMATION (confirm:true + consentToken) and the same SANDBOX / live-key gate + " +
    "uncertain-retry semantics as q402_stake.",
  inputSchema: {
    type: "object" as const,
    properties: {
      amount: { type: "string" as const, description: 'Human-readable Q amount to unstake, e.g. "1000".' },
      walletId: { type: "string" as const, description: "Optional Agent Wallet address. Defaults to the owner's default wallet." },
      confirm: { type: "boolean" as const, description: "MUST be true to actually unstake — only after user approval. Omit to preview." },
      consentToken: { type: "string" as const, description: "Two-phase consent token. Leave unset to preview + get a token; re-call with confirm:true + this token." },
    },
    required: ["amount"],
    additionalProperties: false,
  },
};

interface StakeData {
  status?: string;
  action?: string;
  chain?: string;
  stakeType?: number;
  amount?: string;
  txHash?: string;
  error?: string;
  message?: string;
}

/** Shared executor for both stake + unstake (action differs). */
async function runStakeAction(
  action: "stake" | "unstake",
  input: { amount: string; stakeType?: number; walletId?: string; confirm?: boolean; consentToken?: string },
) {
  if (!(Number(input.amount) > 0)) {
    return { content: [{ type: "text" as const, text: `amount must be greater than zero (got "${input.amount}").` }], isError: true };
  }

  const walletId =
    typeof input.walletId === "string" && input.walletId.length > 0 ? input.walletId.toLowerCase() : CONFIG.walletId ?? undefined;
  const stakeType = action === "stake" ? Number(input.stakeType ?? 0) : undefined;
  const tier = STAKE_TIERS.find((t) => t.stakeType === stakeType);

  // Two-phase consent — MOVES FUNDS.
  const consentIntent = { t: `q-${action}`, amount: input.amount, stakeType: stakeType ?? null, walletId: walletId ?? null };
  const consent = checkConsent(consentIntent, input.consentToken);
  if (input.confirm !== true || !consent.ok) {
    const walletDesc = walletId ? `wallet ${walletId}` : "your default Agent Wallet";
    const what =
      action === "stake"
        ? `stake ${input.amount} Q into tier ${stakeType} (${tier?.lockDays}d lock, ~${tier?.aprPct}% APR) on BNB from ${walletDesc}`
        : `unstake ${input.amount} Q from QuackAiStake on BNB to ${walletDesc}`;
    return {
      content: [{ type: "text" as const, text: `Will ${what}. This MOVES FUNDS. Confirm with the user, then re-call with confirm:true AND consentToken="${consent.expected}".` }],
    };
  }

  const resolved = resolveApiKey("bnb", "multichain");
  if (!resolved.apiKey || !resolved.apiKey.startsWith("q402_live_")) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ configured: false, status: "error", setupHint: resolved.sandboxReason ?? "No live Q402 Multichain API key configured. Set Q402_MULTICHAIN_API_KEY to a q402_live_… key, or run q402_doctor." }, null, 2) }],
      isError: true,
    };
  }

  if (!CONFIG.realPaymentsRequested) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ sandbox: true, success: false, status: "sandbox", action, amount: input.amount, stakeType: stakeType ?? null, walletId: walletId ?? null, setupHint: "Sandbox mode — set Q402_ENABLE_REAL_PAYMENTS=1 to fire a real stake/unstake. No funds moved." }, null, 2) }],
    };
  }

  let res: Response;
  try {
    res = await fetch(`${CONFIG.relayBaseUrl}/wallet/agentic/stake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: resolved.apiKey, action, amount: input.amount, ...(action === "stake" ? { stakeType } : {}), ...(walletId ? { walletId } : {}) }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ status: "uncertain", success: false, action, amount: input.amount, error: e instanceof Error ? e.message : String(e), message: `Network error before a confirmed response — the ${action} may or may not have submitted. Do NOT blindly retry; the server dedupes an identical call for 15 min, so a retry within that window resumes this op instead of doubling it.` }, null, 2) }],
      isError: true,
    };
  }

  const data = (await res.json().catch(() => ({}))) as StakeData;
  if (!res.ok) {
    if (res.status === 502 || data.status === "uncertain") {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ status: "uncertain", success: false, action, amount: input.amount, txHash: data.txHash ?? null, error: data.error ?? "settlement_uncertain", message: `Broadcast but unconfirmed — the ${action} may have settled. Verify on-chain first. A retry of the identical call within 15 min resumes this op rather than doubling it.` }, null, 2) }],
        isError: true,
      };
    }
    return { content: [{ type: "text" as const, text: `Q ${action} failed (HTTP ${res.status}): ${JSON.stringify(data)}` }], isError: true };
  }

  const summary = data.txHash
    ? `${action === "stake" ? "Staked" : "Unstaked"} ${data.amount ?? input.amount} Q on BNB${action === "stake" && tier ? ` (tier ${stakeType}, ${tier.lockDays}d, ~${tier.aprPct}% APR)` : ""}. txHash ${data.txHash}.`
    : `Q ${action} submitted on BNB.`;
  return { content: [{ type: "text" as const, text: summary }, { type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export async function runStake(input: z.infer<typeof StakeInputSchema>) {
  return runStakeAction("stake", input);
}

export async function runUnstake(input: z.infer<typeof UnstakeInputSchema>) {
  return runStakeAction("unstake", input);
}
