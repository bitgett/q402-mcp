/**
 * q402_bridge_quote — read-only CCIP fee quote.
 *
 * Returns LINK + native fee estimates for a hypothetical USDC bridge across
 * the 3-chain CCIP triangle (eth/avax/arbitrum). No state change, no auth.
 * Use this to show the user the cost before they commit to q402_bridge_send.
 */

import { z } from "zod";
import { CONFIG } from "../config.js";

export const BridgeQuoteInputSchema = z.object({
  src: z.enum(["eth", "avax", "arbitrum"]).describe("Source chain"),
  dst: z.enum(["eth", "avax", "arbitrum"]).describe("Destination chain"),
  // Same `> 0` requirement as bridge-send so the quote doesn't
  // return a meaningless "fee for 0 USDC" envelope.
  amount: z.string().regex(/^\d*[1-9]\d*$/).describe("USDC amount in raw 6-decimal units, > 0 (e.g. '1000000' = 1 USDC)"),
  destReceiver: z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("Destination receiver address (Agentic Wallet on destination)"),
}).refine(d => d.src !== d.dst, {
  // Mirror the rejection in BridgeSendInputSchema so an agent that
  // accidentally quotes a same-chain "bridge" fails locally instead of
  // burning a round-trip through /api/ccip/quote.
  message: "src must differ from dst",
  path: ["dst"],
});

export const BRIDGE_QUOTE_TOOL = {
  name: "q402_bridge_quote",
  description:
    "Quote the Chainlink CCIP fee for bridging USDC across the 3-chain triangle (eth/avax/arbitrum). " +
    "Returns BOTH the LINK fee (~10% cheaper) and the native fee, so the agent can pick the cheaper " +
    "path or surface both options to the user. Read-only; no auth required.",
  inputSchema: {
    type: "object" as const,
    properties: {
      src: {
        type: "string" as const,
        enum: ["eth", "avax", "arbitrum"],
        description: "Source chain.",
      },
      dst: {
        type: "string" as const,
        enum: ["eth", "avax", "arbitrum"],
        description: "Destination chain (MUST differ from src; pool only routes inside the 3-chain triangle).",
      },
      amount: {
        type: "string" as const,
        pattern: "^[0-9]+$",
        description: "USDC amount in raw 6-decimal units (e.g. '1000000' = 1 USDC). Integer string only.",
      },
      destReceiver: {
        type: "string" as const,
        pattern: "^0x[0-9a-fA-F]{40}$",
        description: "Destination receiver (0x 20-byte address). Same EOA on the destination chain.",
      },
    },
    required: ["src", "dst", "amount", "destReceiver"],
  },
};

export async function runBridgeQuote(input: z.infer<typeof BridgeQuoteInputSchema>) {
  const url = new URL("/api/ccip/quote", CONFIG.relayBaseUrl);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  type FeeSlice = { raw: string; whole: number; usd: number };
  type QuoteData = {
    recommended?: "link" | "native";
    fee?: { link?: FeeSlice; native?: FeeSlice };
  };
  const data = (await res.json()) as QuoteData;
  if (!res.ok) {
    return { content: [{ type: "text" as const, text: `Quote failed (HTTP ${res.status}): ${JSON.stringify(data)}` }], isError: true };
  }
  // Surface the cheaper option as a one-liner so the agent doesn't have
  // to parse the blob to compare fees. Full quote follows in the second
  // block for traceability.
  const recommended = data.recommended;
  const link = data.fee?.link;
  const native = data.fee?.native;
  const otherKey = recommended === "link" ? "native" : "link";
  const recUsd = recommended ? data.fee?.[recommended]?.usd : undefined;
  const otherUsd = recommended ? data.fee?.[otherKey]?.usd : undefined;
  const cheaper = recommended && typeof recUsd === "number"
    ? `Cheaper: ${recommended.toUpperCase()} (~$${recUsd.toFixed(4)} vs $${(otherUsd ?? 0).toFixed(4)})`
    : "Quote returned.";
  return {
    content: [
      { type: "text" as const, text: cheaper },
      { type: "text" as const, text: JSON.stringify({ recommended, link, native }, null, 2) },
    ],
  };
}
