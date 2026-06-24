/**
 * q402_stake_positions — read-only Q staking snapshot for the Agent Wallet.
 *
 * Returns the wallet's open Q (QuackAI) stakes on QuackAiStake (BNB): per
 * position the tier, principal, APR, stake/unlock time, and matured flag —
 * plus aggregate stakedTotal, the matured/withdrawable total (the unstake
 * "max"), and the liquid Q balance (the stake "max"). No funds move.
 *
 * Authenticated by the live Multichain API key in the `x-api-key` HEADER,
 * exactly like q402_yield_positions. The shared fetchStakePositions() helper
 * is also used by q402_stake / q402_unstake to resolve an "max" amount before
 * settling.
 */

import { z } from "zod";
import { CONFIG, resolveApiKey } from "../config.js";

export interface StakePositionRecord {
  /** 0-based array index — the argument to unstake (exit(ith)). */
  ith: number;
  /** On-chain stakeId (display only, NOT the unstake arg). */
  id: number;
  stakeType: number;
  amount: string;
  aprPct: number;
  stakedAt: number;
  unlockAt: number;
  matured: boolean;
  /** matured && ith>=1 && not exited — can be unstaked now. */
  exitable: boolean;
}

export interface StakePositionsData {
  walletId?: string;
  positions?: StakePositionRecord[];
  stakedTotal?: string;
  withdrawable?: string;
  withdrawableRaw?: string;
  qBalance?: string;
  qBalanceRaw?: string;
  error?: string;
  message?: string;
}

/**
 * GET the stake positions for the apiKey owner's wallet. Returns the raw
 * { ok, status, data } tuple — callers decide how to surface failures.
 * Throws only on a network/timeout error (let the caller translate it).
 */
export async function fetchStakePositions(
  apiKey: string,
  walletId: string | undefined,
  timeoutMs = 15_000,
): Promise<{ ok: boolean; status: number; data: StakePositionsData }> {
  // String-concat (not new URL("/path", base)) so the base's `/api` segment
  // is preserved — mirrors yield-positions.ts.
  const url = new URL(`${CONFIG.relayBaseUrl}/wallet/agentic/stake/positions`);
  if (walletId) url.searchParams.set("walletId", walletId);
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json", "x-api-key": apiKey },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = (await res.json().catch(() => ({}))) as StakePositionsData;
  return { ok: res.ok, status: res.status, data };
}

export const StakePositionsInputSchema = z.object({
  walletId: z
    .string()
    .optional()
    .describe("Optional Agent Wallet address whose stakes to read. Omit for the owner's default wallet (resolved from the API key)."),
});

export const STAKE_POSITIONS_TOOL = {
  name: "q402_stake_positions",
  description:
    "READ-ONLY — show the Agent Wallet's open Q (QuackAI) staking positions on QuackAiStake (BNB). " +
    "Returns each position's tier (0=30d/10% … 3=180d/40% APR), principal Q, APR, stake + unlock time, and " +
    "whether it has matured (unlockable), plus the aggregate staked total, the matured/withdrawable total " +
    "(the unstake 'max'), and the liquid Q balance (the stake 'max'). Authenticated by the configured live " +
    "Multichain API key — no private key, no funds move. Use it for 'what are my Q stakes?', 'how much Q can " +
    "I unstake?', or before q402_unstake with amount 'max'.",
  inputSchema: {
    type: "object" as const,
    properties: {
      walletId: {
        type: "string" as const,
        description: "Optional Agent Wallet address. Omit to read the owner's default wallet (resolved from the API key).",
      },
    },
    additionalProperties: false,
  },
};

export async function runStakePositions(input: z.infer<typeof StakePositionsInputSchema>) {
  const resolved = resolveApiKey("bnb", "multichain");
  if (!resolved.apiKey || !resolved.apiKey.startsWith("q402_live_")) {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          configured: false,
          positions: null,
          setupHint:
            resolved.sandboxReason ??
            "No live Q402 Multichain API key configured. Set Q402_MULTICHAIN_API_KEY to a q402_live_… key, or run q402_doctor.",
        }, null, 2),
      }],
      isError: true,
    };
  }

  const walletId =
    typeof input.walletId === "string" && input.walletId.length > 0 ? input.walletId.toLowerCase() : CONFIG.walletId ?? undefined;

  let result: { ok: boolean; status: number; data: StakePositionsData };
  try {
    result = await fetchStakePositions(resolved.apiKey, walletId);
  } catch (e) {
    return {
      content: [{ type: "text" as const, text: `Stake positions fetch failed: ${e instanceof Error ? e.message : String(e)}. Retry in a moment.` }],
      isError: true,
    };
  }

  if (!result.ok) {
    return {
      content: [{ type: "text" as const, text: `Stake positions failed (HTTP ${result.status}): ${JSON.stringify(result.data)}` }],
      isError: true,
    };
  }

  const data = result.data;
  const positions = data.positions ?? [];
  const summary = positions.length
    ? `${positions.length} Q stake(s): ${data.stakedTotal ?? "0"} Q staked, ${data.withdrawable ?? "0"} Q matured (unstakable now), ${data.qBalance ?? "0"} Q liquid.`
    : `No open Q stakes for this wallet. Liquid Q balance: ${data.qBalance ?? "0"}.`;

  return {
    content: [
      { type: "text" as const, text: summary },
      {
        type: "text" as const,
        text: JSON.stringify({
          walletId: data.walletId ?? walletId ?? null,
          positions,
          stakedTotal: data.stakedTotal ?? "0",
          withdrawable: data.withdrawable ?? "0",
          qBalance: data.qBalance ?? "0",
        }, null, 2),
      },
    ],
  };
}
