/**
 * q402_yield_positions — read-only Q402 Yield (Aave) position snapshot.
 *
 * Returns the Agent Wallet's current lending positions: per-market the
 * CURRENT supplied position value (the live aToken balance, which already
 * includes accrued interest but is NOT broken out into principal vs.
 * earnings) and the live supply APY, plus an aggregate current value in
 * USD. No state change, no funds move.
 *
 * NOTE: this Phase-0 read does NOT report principal or accrued earnings as
 * separate figures — the server returns those as null (it tracks no
 * deposit-time principal yet), so we surface only what's real: the current
 * position value + APY. Do not present a "you've earned $X" number from this
 * tool; it isn't available.
 *
 * Authenticated by the live Multichain API key, sent in the `x-api-key`
 * header (the same resolved key the Mode C pay path uses). The walletId
 * is optional — when omitted, the landing route resolves the owner's
 * default Agent Wallet from the apiKey, so we only pass walletId when the
 * caller explicitly provides one (or Q402_AGENT_WALLET_ADDRESS is set).
 */

import { z } from "zod";
import { CONFIG, resolveApiKey } from "../config.js";

export const YieldPositionsInputSchema = z.object({
  walletId: z
    .string()
    .optional()
    .describe(
      "Optional Agent Wallet address whose positions to read (max 10 per owner). " +
        "Omit and the server defaults to the owner's default wallet (resolved from the " +
        "API key); Q402_AGENT_WALLET_ADDRESS env fills it in when set.",
    ),
  chain: z
    .enum(["bnb", "base"])
    .optional()
    .describe("Optional chain filter. Aave positions on 'bnb', Morpho positions on 'base'. Omit for all supported chains."),
});

export const YIELD_POSITIONS_TOOL = {
  name: "q402_yield_positions",
  description:
    "READ-ONLY — show the Agent Wallet's current Q402 Yield (Aave) lending positions. Returns each " +
    "position's protocol, chain, asset, market address, CURRENT supplied position value (the live " +
    "aToken balance, in token units), and live supply APY, plus the aggregate current value in USD. " +
    "Authenticated by the configured live Multichain API key — no private key required and no funds move. " +
    "Reads BNB Chain (Aave V3), plus Base (Morpho) when a curated vault is configured; deposit/withdraw are BNB-only today. " +
    "DOES NOT report principal or accrued earnings as separate numbers — the aToken balance already " +
    "includes accrued interest but is not broken out, so do NOT claim a specific 'earnings/profit/" +
    "interest earned' figure from this tool; report only the current position value and the APY. " +
    "walletId is OPTIONAL: omit it and the server reads the owner's default Agent Wallet " +
    "(resolved from the API key); pass one only when the owner holds more than one wallet. " +
    "An optional chain filter is also accepted. Use this whenever the user asks 'what is my position " +
    "worth?', 'what's my current yield balance / APY?', or 'what are my open lending positions?'",
  inputSchema: {
    type: "object" as const,
    properties: {
      walletId: {
        type: "string" as const,
        description:
          "Optional Agent Wallet address. Omit to read the owner's default wallet (the server " +
          "resolves it from the API key); pass one only when the owner holds multiple wallets. " +
          "Q402_AGENT_WALLET_ADDRESS env fills it in when set.",
      },
      chain: {
        type: "string" as const,
        enum: ["bnb", "base"],
        description: "Optional chain filter. Aave positions on 'bnb', Morpho positions on 'base'. Omit for all supported chains.",
      },
    },
    additionalProperties: false,
  },
};

interface Position {
  protocol: string;
  chain: string;
  asset: string;
  marketAddress: string;
  /** CURRENT supplied position value in token units (live aToken balance).
   *  This is the redeemable amount and already includes any accrued
   *  interest — it is NOT split into principal vs. earnings. */
  balance: string;
  /** Phase-0 server returns these as null — deposit-time principal isn't
   *  tracked yet, so accrued earnings can't be derived. Typed nullable so we
   *  never present a fabricated earnings figure. */
  principal: string | null;
  accrued: string | null;
  /** Fraction — 0.021 means 2.1% APY. */
  supplyApy: number;
}

interface PositionsData {
  walletId?: string;
  positions?: Position[];
  totalSuppliedUsd?: number;
  asOf?: string;
  /**
   * Chains the server could NOT read this cycle (per-chain RPC blip while
   * fetching aToken balances + rates). Surfaced so a read FAILURE is
   * distinguishable from a genuinely empty position — dropping it would make
   * a transient RPC error look like "no position" and could mislead a
   * downstream `withdraw max` decision. `unavailable` is the boolean form
   * some server builds return alongside (or instead of) the list.
   */
  unavailable?: boolean;
  unavailableChains?: string[];
}

export async function runYieldPositions(input: z.infer<typeof YieldPositionsInputSchema>) {
  // Yield positions are a Multichain-scope read (Aave lanes are non-BNB);
  // the resolver returns the live Multichain key (or legacy fallback).
  const resolved = resolveApiKey("eth", "multichain");
  if (!resolved.apiKey || !resolved.apiKey.startsWith("q402_live_")) {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          configured: false,
          positions: null,
          setupHint:
            resolved.sandboxReason ??
            "No live Q402 Multichain API key configured. Set Q402_MULTICHAIN_API_KEY to a " +
              "q402_live_… key from https://q402.quackai.ai/payment, or run q402_doctor.",
        }, null, 2),
      }],
      isError: true,
    };
  }

  // Resolution order: tool input → Q402_AGENT_WALLET_ADDRESS env → server
  // default (omit the query param so the route resolves the apiKey owner's
  // default wallet).
  const walletId =
    typeof input.walletId === "string" && input.walletId.length > 0
      ? input.walletId.toLowerCase()
      : CONFIG.walletId ?? undefined;

  // Build off CONFIG.relayBaseUrl by STRING CONCAT (same as pay.ts) so the
  // base's `/api` segment is preserved. `new URL("/path", origin)` would
  // resolve the absolute "/path" against the origin only and silently drop
  // `/api`, 404-ing the call.
  const url = new URL(`${CONFIG.relayBaseUrl}/wallet/agentic/yield/positions`);
  if (walletId) url.searchParams.set("walletId", walletId);
  if (input.chain) url.searchParams.set("chain", input.chain);

  let res: Response;
  try {
    // 15s timeout — positions reads aToken balances + rates on-chain;
    // fail fast on an RPC blip rather than hang the MCP client.
    res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "x-api-key": resolved.apiKey,
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    return {
      content: [{
        type: "text" as const,
        text: `Yield positions fetch failed: ${e instanceof Error ? e.message : String(e)}. Retry in a moment.`,
      }],
      isError: true,
    };
  }

  const data = (await res.json().catch(() => ({}))) as PositionsData;
  if (!res.ok) {
    return {
      content: [{
        type: "text" as const,
        text: `Yield positions failed (HTTP ${res.status}): ${JSON.stringify(data)}`,
      }],
      isError: true,
    };
  }

  const positions = data.positions ?? [];
  // Surface per-chain read failures so an RPC blip isn't reported as an empty
  // position. The server flags them via `unavailableChains` (list) and/or
  // `unavailable` (boolean) — honour either form.
  const unavailableChains = Array.isArray(data.unavailableChains) ? data.unavailableChains : [];
  const hasUnavailable = data.unavailable === true || unavailableChains.length > 0;

  // One-line aggregate so the LLM can answer "what's my position worth?"
  // without parsing the blob; full position list follows for traceability.
  // This is CURRENT VALUE (live aToken balance), not "earnings" — the server
  // doesn't report accrued profit, so don't imply one. When some chains
  // failed to read, say so explicitly instead of implying a zero balance —
  // the snapshot is PARTIAL, not necessarily empty.
  const unavailableNote = hasUnavailable
    ? ` Some chains could not be read this cycle${
        unavailableChains.length ? ` (${unavailableChains.join(", ")})` : ""
      } — this snapshot may be incomplete; retry before treating a balance as zero.`
    : "";
  const summary = positions.length
    ? `Total current position value: $${(data.totalSuppliedUsd ?? 0).toFixed(2)} across ` +
      `${positions.length} position(s) (live aToken balance incl. accrued interest; ` +
      `earnings are not broken out).${unavailableNote}`
    : hasUnavailable
      ? `No positions returned, but a read failure occurred${
          unavailableChains.length ? ` on ${unavailableChains.join(", ")}` : ""
        } — this is NOT a confirmed empty position; retry.`
      : "No open Q402 Yield positions for this wallet.";

  return {
    content: [
      { type: "text" as const, text: summary },
      {
        type: "text" as const,
        text: JSON.stringify({
          walletId: data.walletId ?? walletId ?? null,
          // Surface only what's real: the current position value (live aToken
          // balance) + APY. `principal`/`accrued` come back null from this
          // Phase-0 read, so they're included ONLY when the server actually
          // populated them — never as a null placeholder that reads like a
          // real (zero) earnings figure.
          positions: positions.map(p => ({
            protocol: p.protocol,
            chain: p.chain,
            asset: p.asset,
            marketAddress: p.marketAddress,
            currentValue: p.balance,
            supplyApy: p.supplyApy,
            supplyApyPct: Math.round(p.supplyApy * 100 * 100) / 100,
            ...(p.principal != null ? { principal: p.principal } : {}),
            ...(p.accrued != null ? { accrued: p.accrued } : {}),
          })),
          totalCurrentValueUsd: data.totalSuppliedUsd ?? null,
          asOf: data.asOf ?? null,
          unavailable: hasUnavailable,
          unavailableChains,
        }, null, 2),
      },
    ],
  };
}
