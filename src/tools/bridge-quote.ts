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
  amount: z.string().regex(/^\d+$/).describe("USDC amount in raw 6-decimal units (e.g. '1000000' = 1 USDC)"),
  destReceiver: z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("Destination receiver address (Agentic Wallet on destination)"),
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
      src:          { type: "string" as const, enum: ["eth", "avax", "arbitrum"], description: "Source chain" },
      dst:          { type: "string" as const, enum: ["eth", "avax", "arbitrum"], description: "Destination chain (must differ from src)" },
      amount:       { type: "string" as const, description: "USDC amount in raw 6-decimal units" },
      destReceiver: { type: "string" as const, description: "Destination receiver (0x address)" },
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
  const data = await res.json();
  if (!res.ok) {
    return { content: [{ type: "text" as const, text: `Quote failed (HTTP ${res.status}): ${JSON.stringify(data)}` }], isError: true };
  }
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}
