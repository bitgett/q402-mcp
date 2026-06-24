/**
 * q402_stake / q402_unstake — WRITE / MOVES FUNDS. Gasless Q (QuackAI) token
 * staking into QuackAiStake on BNB (and unstaking back) from a server-managed
 * Agent Wallet (Mode C). The server holds the encrypted key, signs the
 * Stake/Unstake witness, and the relayer sponsors gas — the MCP never holds a
 * key for this path. Thin wrapper over POST /api/wallet/agentic/stake.
 *
 * STAKE binds an amount (supports "max" = the wallet's whole Q balance, resolved
 * server-side + capped). UNSTAKE is per-record: QuackAiStake.exit(ith) exits ONE
 * matured record (all-or-nothing) by its array index. "Unstake all matured" loops
 * the exitable records. Index 0 is un-exitable on-chain (the impl seeds a dust
 * record there on the first stake so real stakes stay exitable).
 *
 * Same two-phase consent + sandbox gate as q402_yield_deposit: MOVES FUNDS, so it
 * refuses to execute without confirm:true + a matching consentToken, and needs a
 * live Multichain key + Q402_ENABLE_REAL_PAYMENTS=1 for real funds.
 */

import { z } from "zod";
import { CONFIG, resolveApiKey } from "../config.js";
import { checkConsent } from "../consent.js";
import { fetchStakePositions, type StakePositionRecord } from "./stake-positions.js";

/** Lock tiers (display only — the staking contract validates + reverts on an unknown tier). */
const STAKE_TIERS = [
  { stakeType: 0, lockDays: 30, aprPct: 10 },
  { stakeType: 1, lockDays: 60, aprPct: 15 },
  { stakeType: 2, lockDays: 120, aprPct: 32 },
  { stakeType: 3, lockDays: 180, aprPct: 40 },
] as const;
const TIER_VALUES = STAKE_TIERS.map((t) => t.stakeType);

// ── q402_stake ────────────────────────────────────────────────────────────

export const StakeInputSchema = z.object({
  amount: z
    .string()
    .regex(/^(\d+(\.\d+)?|max)$/i, 'amount must be a positive decimal string or "max"')
    .describe('Human-readable Q amount to stake, e.g. "1000", or "max" for the wallet\'s whole Q balance.'),
  stakeType: z
    .number()
    .int()
    .refine((v) => TIER_VALUES.includes(v as (typeof TIER_VALUES)[number]), "unknown stakeType")
    .describe(
      "Lock tier: 0=30d/10% 1=60d/15% 2=120d/32% 3=180d/40% APR. " +
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
    "the encrypted key, signs the stake, and sponsors gas. Pick a lock tier (stakeType 0-3): " +
    "0=30d/10%, 1=60d/15%, 2=120d/32%, 3=180d/40% APR — longer lock, higher APR. Q is BNB-only. " +
    'amount accepts "max" (stake the wallet\'s whole Q balance). \n\n' +
    "REQUIRES CONFIRMATION — like q402_pay, refuses to execute unless confirm:true. Call FIRST " +
    "without confirm to preview (amount, tier, lock, wallet); show the user, get approval, THEN " +
    "re-call with confirm:true + the consentToken. \n\n" +
    "SANDBOX BY DEFAULT — no funds move unless a live Multichain key (q402_live_*) is configured " +
    "AND Q402_ENABLE_REAL_PAYMENTS=1. \n\n" +
    "RETRY SAFETY — on status=\"uncertain\" (broadcast unconfirmed) the stake MAY have settled; do " +
    "NOT blindly retry. The server dedupes identical (tier, amount) calls for 15 min.",
  inputSchema: {
    type: "object" as const,
    properties: {
      amount: { type: "string" as const, description: 'Human-readable Q amount to stake, e.g. "1000", or "max" for the whole Q balance.' },
      stakeType: { type: "number" as const, enum: TIER_VALUES as unknown as number[], description: "Lock tier 0-3 (0=30d/10% … 3=180d/40% APR). Longer lock = higher APR." },
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
  ith: z
    .number()
    .int()
    .optional()
    .describe("Record index to unstake (exit a single matured stake). Get it from q402_stake_positions. Must be >= 1. Omit and set all:true to exit every matured stake."),
  all: z
    .boolean()
    .optional()
    .describe("Set true to unstake EVERY matured (exitable) stake — one on-chain exit per record. Mutually exclusive with ith."),
  walletId: z.string().optional().describe("Optional Agent Wallet address to unstake from. Omit for the default."),
  confirm: z.boolean().optional().describe("MUST be true to actually unstake. Omit to preview."),
  consentToken: z.string().optional().describe("Two-phase consent — leave unset to preview + get a token, then re-call with confirm:true + this token."),
});

export const UNSTAKE_TOOL = {
  name: "q402_unstake",
  description:
    "WRITE — MOVES FUNDS. Unstakes the Agent Wallet's matured Q from QuackAiStake on BNB back to " +
    "the wallet, gaslessly (Mode C, server-signed, relayer-sponsored gas). Unstake is PER-RECORD: " +
    "QuackAiStake exits one matured stake at a time by its index. Pass `ith` (a record index from " +
    "q402_stake_positions) to exit one stake, or `all: true` to exit EVERY matured stake (one tx " +
    "per record). A stake can only be unstaked after its lock elapses. \n\n" +
    "REQUIRES CONFIRMATION (confirm:true + consentToken) and the same SANDBOX / live-key gate + " +
    "uncertain-retry semantics as q402_stake. Use q402_stake_positions first to see which records " +
    "are exitable.",
  inputSchema: {
    type: "object" as const,
    properties: {
      ith: { type: "number" as const, description: "Record index to exit (one matured stake). From q402_stake_positions. Must be >= 1." },
      all: { type: "boolean" as const, description: "Exit EVERY matured stake (one on-chain exit per record). Mutually exclusive with ith." },
      walletId: { type: "string" as const, description: "Optional Agent Wallet address. Defaults to the owner's default wallet." },
      confirm: { type: "boolean" as const, description: "MUST be true to actually unstake — only after user approval. Omit to preview." },
      consentToken: { type: "string" as const, description: "Two-phase consent token. Leave unset to preview + get a token; re-call with confirm:true + this token." },
    },
    additionalProperties: false,
  },
};

interface StakeActionData {
  status?: string;
  action?: string;
  chain?: string;
  stakeType?: number;
  amount?: string;
  ith?: number;
  txHash?: string;
  error?: string;
  message?: string;
}

/** Resolve the live Multichain key or an error envelope (MOVES FUNDS → live only). */
function requireLiveKey(): { apiKey: string } | { error: { content: { type: "text"; text: string }[]; isError: true } } {
  const resolved = resolveApiKey("bnb", "multichain");
  if (!resolved.apiKey || !resolved.apiKey.startsWith("q402_live_")) {
    return {
      error: {
        content: [{ type: "text" as const, text: JSON.stringify({ configured: false, status: "error", setupHint: resolved.sandboxReason ?? "No live Q402 Multichain API key configured. Set Q402_MULTICHAIN_API_KEY to a q402_live_… key, or run q402_doctor." }, null, 2) }],
        isError: true,
      },
    };
  }
  return { apiKey: resolved.apiKey };
}

/** POST one stake/unstake action to the landing route. */
async function postStake(apiKey: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: StakeActionData }> {
  const res = await fetch(`${CONFIG.relayBaseUrl}/wallet/agentic/stake`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey, ...body }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = (await res.json().catch(() => ({}))) as StakeActionData;
  return { ok: res.ok, status: res.status, data };
}

function resolveWalletId(input: { walletId?: string }): string | undefined {
  return typeof input.walletId === "string" && input.walletId.length > 0 ? input.walletId.toLowerCase() : CONFIG.walletId ?? undefined;
}

export async function runStake(input: z.infer<typeof StakeInputSchema>) {
  const walletId = resolveWalletId(input);
  const stakeType = Number(input.stakeType ?? 0);
  const tier = STAKE_TIERS.find((t) => t.stakeType === stakeType);
  const isMax = input.amount.toLowerCase() === "max";

  // For "max" we resolve the cap (the wallet's Q balance) up front so the preview
  // shows a concrete number and the server stakes min(live balance, cap).
  let cap: string | undefined;
  let previewAmount = input.amount;
  if (isMax) {
    const live = requireLiveKey();
    if ("error" in live) return live.error;
    try {
      const { ok, data } = await fetchStakePositions(live.apiKey, walletId);
      if (ok && data.qBalance && Number(data.qBalance) > 0) {
        cap = data.qBalance;
        previewAmount = `${data.qBalance} (max)`;
      } else {
        return { content: [{ type: "text" as const, text: "No Q balance to stake." }], isError: true };
      }
    } catch {
      // fall through — preview without a concrete number; server still resolves max+cap
    }
  } else if (!(Number(input.amount) > 0)) {
    return { content: [{ type: "text" as const, text: `amount must be greater than zero (got "${input.amount}").` }], isError: true };
  }

  const consentIntent = { t: "q-stake", amount: isMax ? "max" : input.amount, stakeType, walletId: walletId ?? null };
  const consent = checkConsent(consentIntent, input.consentToken);
  if (input.confirm !== true || !consent.ok) {
    const walletDesc = walletId ? `wallet ${walletId}` : "your default Agent Wallet";
    return {
      content: [{ type: "text" as const, text: `Will stake ${previewAmount} Q into tier ${stakeType} (${tier?.lockDays}d lock, ~${tier?.aprPct}% APR) on BNB from ${walletDesc}. This MOVES FUNDS. Confirm with the user, then re-call with confirm:true AND consentToken="${consent.expected}".` }],
    };
  }

  const live = requireLiveKey();
  if ("error" in live) return live.error;
  if (!CONFIG.realPaymentsRequested) {
    return { content: [{ type: "text" as const, text: JSON.stringify({ sandbox: true, success: false, status: "sandbox", action: "stake", amount: isMax ? "max" : input.amount, stakeType, walletId: walletId ?? null, setupHint: "Sandbox mode — set Q402_ENABLE_REAL_PAYMENTS=1 to fire a real stake. No funds moved." }, null, 2) }] };
  }

  let res: { ok: boolean; status: number; data: StakeActionData };
  try {
    res = await postStake(live.apiKey, { action: "stake", amount: isMax ? "max" : input.amount, ...(cap ? { cap } : {}), stakeType, ...(walletId ? { walletId } : {}) });
  } catch (e) {
    return { content: [{ type: "text" as const, text: JSON.stringify({ status: "uncertain", success: false, action: "stake", error: e instanceof Error ? e.message : String(e), message: "Network error before a confirmed response — the stake may or may not have submitted. Do NOT blindly retry; the server dedupes an identical call for 15 min." }, null, 2) }], isError: true };
  }

  const data = res.data;
  if (!res.ok) {
    if (res.status === 502 || data.status === "uncertain") {
      return { content: [{ type: "text" as const, text: JSON.stringify({ status: "uncertain", success: false, action: "stake", txHash: data.txHash ?? null, error: data.error ?? "settlement_uncertain", message: "Broadcast but unconfirmed — the stake may have settled. Verify on-chain first." }, null, 2) }], isError: true };
    }
    return { content: [{ type: "text" as const, text: `Q stake failed (HTTP ${res.status}): ${JSON.stringify(data)}` }], isError: true };
  }

  const summary = data.txHash
    ? `Staked ${data.amount ?? input.amount} Q on BNB${tier ? ` (tier ${stakeType}, ${tier.lockDays}d, ~${tier.aprPct}% APR)` : ""}. txHash ${data.txHash}.`
    : "Q stake submitted on BNB.";
  return { content: [{ type: "text" as const, text: summary }, { type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export async function runUnstake(input: z.infer<typeof UnstakeInputSchema>) {
  const walletId = resolveWalletId(input);
  const all = input.all === true;
  const ith = typeof input.ith === "number" ? input.ith : undefined;

  if (all && ith !== undefined) {
    return { content: [{ type: "text" as const, text: "Pass either ith (one record) or all:true (every matured record), not both." }], isError: true };
  }
  if (!all && ith === undefined) {
    return { content: [{ type: "text" as const, text: "Provide ith (a record index from q402_stake_positions) or all:true to unstake every matured stake." }], isError: true };
  }
  if (!all && (!Number.isInteger(ith) || (ith as number) < 1)) {
    return { content: [{ type: "text" as const, text: "ith must be an integer >= 1 (index 0 is un-exitable). See q402_stake_positions." }], isError: true };
  }

  const live = requireLiveKey();
  if ("error" in live) return live.error;

  // Resolve which records will be exited (matured + exitable) for the preview + loop.
  let exitable: StakePositionRecord[];
  try {
    const { ok, data } = await fetchStakePositions(live.apiKey, walletId);
    if (!ok) return { content: [{ type: "text" as const, text: `Could not read stake positions (HTTP ${data.error ?? "?"}). Retry.` }], isError: true };
    exitable = (data.positions ?? []).filter((p) => p.exitable);
  } catch (e) {
    return { content: [{ type: "text" as const, text: `Stake positions read failed: ${e instanceof Error ? e.message : String(e)}. Retry.` }], isError: true };
  }

  const targets = all ? exitable : exitable.filter((p) => p.ith === ith);
  if (targets.length === 0) {
    return {
      content: [{ type: "text" as const, text: all ? "No matured (exitable) Q positions to unstake." : `Stake at index ${ith} is not exitable now (not matured, already exited, or index 0). Check q402_stake_positions.` }],
    };
  }
  const totalQ = targets.reduce((acc, t) => acc + Number(t.amount), 0);

  const consentIntent = { t: all ? "q-unstake-all" : "q-unstake", walletId: walletId ?? null, ith: all ? null : ith };
  const consent = checkConsent(consentIntent, input.consentToken);
  if (input.confirm !== true || !consent.ok) {
    const what = all
      ? `unstake ${targets.length} matured position(s) totalling ~${totalQ} Q (one tx each)`
      : `unstake the matured position at index ${ith} (~${totalQ} Q)`;
    return {
      content: [{ type: "text" as const, text: `Will ${what} from ${walletId ? `wallet ${walletId}` : "your default Agent Wallet"} on BNB. This MOVES FUNDS. Confirm with the user, then re-call with confirm:true AND consentToken="${consent.expected}".` }],
    };
  }

  if (!CONFIG.realPaymentsRequested) {
    return { content: [{ type: "text" as const, text: JSON.stringify({ sandbox: true, success: false, status: "sandbox", action: "unstake", positions: targets.map((t) => t.ith), setupHint: "Sandbox mode — set Q402_ENABLE_REAL_PAYMENTS=1 to fire a real unstake. No funds moved." }, null, 2) }] };
  }

  // Execute one exit per target record (sequential). Stop on the first uncertain
  // result so we don't compound an unconfirmed broadcast.
  const results: Array<{ ith: number; status: string; txHash?: string; error?: string }> = [];
  for (const t of targets) {
    try {
      const r = await postStake(live.apiKey, { action: "unstake", ith: t.ith, ...(walletId ? { walletId } : {}) });
      if (r.ok) {
        results.push({ ith: t.ith, status: "settled", txHash: r.data.txHash });
      } else if (r.status === 502 || r.data.status === "uncertain") {
        results.push({ ith: t.ith, status: "uncertain", txHash: r.data.txHash, error: r.data.error });
        break;
      } else {
        results.push({ ith: t.ith, status: "failed", error: r.data.error ?? `HTTP ${r.status}` });
      }
    } catch (e) {
      results.push({ ith: t.ith, status: "uncertain", error: e instanceof Error ? e.message : String(e) });
      break;
    }
  }

  const settled = results.filter((r) => r.status === "settled").length;
  const uncertain = results.some((r) => r.status === "uncertain");
  const summary = `Unstaked ${settled}/${targets.length} matured position(s) on BNB${uncertain ? " — one result is UNCERTAIN (broadcast unconfirmed); verify on-chain before retrying." : "."}`;
  return {
    content: [
      { type: "text" as const, text: summary },
      { type: "text" as const, text: JSON.stringify({ action: "unstake", results }, null, 2) },
    ],
    ...(uncertain ? { isError: true } : {}),
  };
}
