/**
 * q402_yield_reserves - read-only Q402 Yield lending-market list.
 *
 * Returns the supply markets the Agent Wallet can lend into: protocol,
 * chain, asset, the position (a)token, the market/pool address, and the
 * current supply APY. No state change, no auth, no funds move. Use this
 * to show the user which assets earn yield (and how much) BEFORE they
 * decide to supply - same "preview first" role q402_bridge_quote plays
 * for bridging.
 */

import { z } from "zod";
import { CONFIG } from "../config.js";

export const YieldReservesInputSchema = z.object({
  chain: z
    .enum(["bnb", "base"])
    .optional()
    .describe("Optional chain filter. Curated lending markets on 'bnb' and 'base'. Omit to list all supported chains."),
});

export const YIELD_RESERVES_TOOL = {
  name: "q402_yield_reserves",
  description:
    "READ-ONLY - list the Q402 Yield lending markets the Agent Wallet can supply into. " +
    "Returns each market's protocol, chain, asset, asset address, position token, market address, " +
    "and current supply APY (shown as a %). No auth required and no funds move - this is purely a " +
    "preview of available yield. " +
    "Reads the curated lending markets on BNB Chain, plus Base when a curated vault is configured; " +
    "each market reports its own protocol/venue. " +
    "Deposit/withdraw (q402_yield_deposit / q402_yield_withdraw) cover both: 'bnb' (USDC/USDT) and 'base' (USDC only). " +
    "Pass an optional `chain` to filter; omit it to see every supported chain. Use this whenever " +
    "the user asks 'where can I earn yield?' or 'what's the lending APY on <asset>?' before supplying.",
  inputSchema: {
    type: "object" as const,
    properties: {
      chain: {
        type: "string" as const,
        enum: ["bnb", "base"],
        description: "Optional chain filter. Curated lending markets on 'bnb' and 'base'. Omit for all supported chains.",
      },
    },
    additionalProperties: false,
  },
};

interface Market {
  protocol: string;
  chain: string;
  asset: string;
  assetAddress: string;
  positionToken: string;
  marketAddress: string;
  /** Fraction - 0.021 means 2.1% APY. */
  supplyApy: number;
  label: string;
}

interface ReservesData {
  supportedChains?: string[];
  markets?: Market[];
  asOf?: string;
}

export async function runYieldReserves(input: z.infer<typeof YieldReservesInputSchema>) {
  // Build off CONFIG.relayBaseUrl by STRING CONCAT (same as pay.ts) so the
  // base's `/api` segment is preserved. `new URL("/path", origin)` would
  // resolve the absolute "/path" against the origin only and silently drop
  // `/api`, 404-ing the call.
  const url = new URL(`${CONFIG.relayBaseUrl}/wallet/agentic/yield/reserves`);
  if (input.chain) url.searchParams.set("chain", input.chain);

  let res: Response;
  try {
    // 15s timeout - reserves is a read of on-chain Aave rate data; RPC
    // blips should fail fast so the agent can retry rather than freeze
    // the MCP client (mirrors q402_bridge_quote).
    res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    return {
      content: [{
        type: "text" as const,
        text: `Yield reserves fetch failed: ${e instanceof Error ? e.message : String(e)}. Retry in a moment.`,
      }],
      isError: true,
    };
  }

  const data = (await res.json().catch(() => ({}))) as ReservesData;
  if (!res.ok) {
    return {
      content: [{
        type: "text" as const,
        text: `Yield reserves failed (HTTP ${res.status}): ${JSON.stringify(data)}`,
      }],
      isError: true,
    };
  }

  const markets = data.markets ?? [];
  // Present supplyApy as a human-readable % alongside the raw fraction so
  // the LLM doesn't mis-narrate 0.021 as "2.1 percentage points off" or
  // restate the fraction as a percent.
  const summary = markets.length
    ? markets
        .map(m => `${m.label} (${m.chain}): ${(m.supplyApy * 100).toFixed(2)}% APY`)
        .join("\n")
    : "No yield markets returned for the requested filter.";

  return {
    content: [
      { type: "text" as const, text: summary },
      {
        type: "text" as const,
        text: JSON.stringify({
          supportedChains: data.supportedChains ?? [],
          markets: markets.map(m => ({
            ...m,
            supplyApyPct: Math.round(m.supplyApy * 100 * 100) / 100,
          })),
          asOf: data.asOf ?? null,
        }, null, 2),
      },
    ],
  };
}
