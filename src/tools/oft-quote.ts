/**
 * q402_oft_quote — read-only USDT0 (LayerZero OFT) bridge fee quote.
 *
 * Returns the native LayerZero fee + the delivered amount for a hypothetical
 * USDT0 bridge across the 5-chain OFT set (eth/arbitrum/mantle/monad/xlayer).
 * No state change, no auth. Companion to q402_bridge_quote (USDC/CCIP).
 */

import { z } from "zod";
import { CONFIG } from "../config.js";

const OFT_CHAINS = ["eth", "arbitrum", "mantle", "monad", "xlayer"] as const;

export const OftQuoteInputSchema = z.object({
  src: z.enum(OFT_CHAINS).describe("Source chain"),
  dst: z.enum(OFT_CHAINS).describe("Destination chain"),
  amount: z.string().regex(/^\d*[1-9]\d*$/).describe("USDT0 amount in raw local-decimal units, > 0 (6-decimal on these chains, e.g. '1000000' = 1 USDT0)"),
}).refine(d => d.src !== d.dst, { message: "src must differ from dst", path: ["dst"] });

export const OFT_QUOTE_TOOL = {
  name: "q402_oft_quote",
  description:
    "Quote the LayerZero fee for bridging USDT (USDT0) across the OFT set (eth/arbitrum/mantle/monad/xlayer). " +
    "Returns the native messaging fee and the amount delivered on the destination. Read-only; no auth. " +
    "For USDC use q402_bridge_quote (CCIP) instead.",
  inputSchema: {
    type: "object" as const,
    properties: {
      src: { type: "string" as const, enum: [...OFT_CHAINS], description: "Source chain." },
      dst: { type: "string" as const, enum: [...OFT_CHAINS], description: "Destination chain (MUST differ from src)." },
      amount: { type: "string" as const, pattern: "^[0-9]+$", description: "USDT0 amount in raw local-decimal units (6-decimal; '1000000' = 1 USDT0). Integer string only." },
    },
    required: ["src", "dst", "amount"],
  },
};

export async function runOftQuote(input: z.infer<typeof OftQuoteInputSchema>) {
  const url = new URL("/api/oft/quote", CONFIG.relayBaseUrl);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    return {
      content: [{ type: "text" as const, text: `Quote fetch failed: ${e instanceof Error ? e.message : String(e)}. Retry in a moment.` }],
      isError: true,
    };
  }
  type QuoteData = {
    nativeFee?: { raw: string; whole: number };
    amountReceived?: string;
    minAmountLD?: string;
    pathLimit?: { minLD: string; maxLD: string };
  };
  const data = (await res.json()) as QuoteData;
  if (!res.ok) {
    return { content: [{ type: "text" as const, text: `Quote failed (HTTP ${res.status}): ${JSON.stringify(data)}` }], isError: true };
  }
  const feeWhole = data.nativeFee?.whole;
  const summary = typeof feeWhole === "number"
    ? `LayerZero fee ~${feeWhole.toFixed(6)} native; delivers ${data.amountReceived ?? "?"} raw USDT0 on ${input.dst}.`
    : "Quote returned.";
  return {
    content: [
      { type: "text" as const, text: summary },
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}
