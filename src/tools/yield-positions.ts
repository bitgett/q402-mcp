/**
 * q402_yield_positions — read-only Q402 Yield (Aave) position snapshot.
 *
 * Returns the Agent Wallet's current lending positions: per-market
 * balance, principal, accrued interest, and supply APY, plus an
 * aggregate total supplied in USD. No state change, no funds move.
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
    .enum(["bnb"])
    .optional()
    .describe("Optional chain filter. Q402 Yield is BNB-only today — only 'bnb' is accepted. Omit for all supported chains."),
});

export const YIELD_POSITIONS_TOOL = {
  name: "q402_yield_positions",
  description:
    "READ-ONLY — show the Agent Wallet's current Q402 Yield (Aave) lending positions. Returns each " +
    "position's protocol, chain, asset, market address, balance, principal, accrued interest, and " +
    "supply APY, plus the aggregate total supplied in USD. Authenticated by the configured live " +
    "Multichain API key — no private key required and no funds move. " +
    "BNB CHAIN ONLY — Q402 Yield supports BNB Chain today. " +
    "walletId is OPTIONAL: omit it and the server reads the owner's default Agent Wallet " +
    "(resolved from the API key); pass one only when the owner holds more than one wallet. " +
    "An optional chain filter is also accepted. Use this whenever the user asks 'how much am I " +
    "earning?' or 'what are my open lending positions?'",
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
        enum: ["bnb"],
        description: "Optional chain filter. Q402 Yield is BNB-only today — only 'bnb' is accepted. Omit for all supported chains.",
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
  balance: string;
  principal: string;
  accrued: string;
  /** Fraction — 0.021 means 2.1% APY. */
  supplyApy: number;
}

interface PositionsData {
  walletId?: string;
  positions?: Position[];
  totalSuppliedUsd?: number;
  asOf?: string;
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
  // One-line aggregate so the LLM can answer "how much am I earning?"
  // without parsing the blob; full position list follows for traceability.
  const summary = positions.length
    ? `Total supplied: $${(data.totalSuppliedUsd ?? 0).toFixed(2)} across ${positions.length} position(s).`
    : "No open Q402 Yield positions for this wallet.";

  return {
    content: [
      { type: "text" as const, text: summary },
      {
        type: "text" as const,
        text: JSON.stringify({
          walletId: data.walletId ?? walletId ?? null,
          positions: positions.map(p => ({
            ...p,
            supplyApyPct: Math.round(p.supplyApy * 100 * 100) / 100,
          })),
          totalSuppliedUsd: data.totalSuppliedUsd ?? null,
          asOf: data.asOf ?? null,
        }, null, 2),
      },
    ],
  };
}
