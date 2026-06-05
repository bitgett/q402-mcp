/**
 * q402_bridge_send — execute a CCIP USDC bridge.
 *
 * Mode C (server-managed Agentic Wallet) only in v1. The Q402 server
 * signs ccipSend as the Agentic Wallet — the agent doesn't need to hold
 * a private key for the bridge call. User must have:
 *   1. An Agentic Wallet with USDC on the source chain
 *   2. Gas Tank balance (LINK or native) on the source chain to cover the fee
 *
 * Sandbox-by-default: live execution requires `Q402_ENABLE_REAL_PAYMENTS=1`
 * AND the user explicitly setting `sandbox: false` on this call.
 */

import { z } from "zod";
import { CONFIG } from "../config.js";

export const BridgeSendInputSchema = z.object({
  src: z.enum(["eth", "avax", "arbitrum"]).describe("Source chain"),
  dst: z.enum(["eth", "avax", "arbitrum"]).describe("Destination chain"),
  amount: z.string().regex(/^\d+$/).describe("USDC amount in raw 6-decimal units"),
  walletId: z.string().describe("Agentic Wallet ID (from q402_agentic_info)"),
  feeToken: z.enum(["LINK", "native", "auto"]).optional().describe("Fee token. 'auto' picks cheaper of the two; defaults to LINK."),
  sandbox: z.boolean().optional().describe("Sandbox mode (default true). Set to false for live bridge."),
});

export const BRIDGE_SEND_TOOL = {
  name: "q402_bridge_send",
  description:
    "Execute a Chainlink CCIP USDC bridge between two of the 3 supported chains (eth/avax/arbitrum). " +
    "The Q402 server signs ccipSend on behalf of the user's Agentic Wallet. Fee is debited from the user's " +
    "Gas Tank (LINK slot or native, per the feeToken arg). " +
    "SANDBOX BY DEFAULT: returns a synthetic messageId unless `sandbox: false` is passed AND the " +
    "server env has Q402_ENABLE_REAL_PAYMENTS=1. ALWAYS confirm the bridge details with the user before " +
    "setting sandbox: false. Recommended flow: q402_bridge_quote first → show user the cost → " +
    "get user confirmation → call q402_bridge_send with sandbox: false.",
  inputSchema: {
    type: "object" as const,
    properties: {
      src:      { type: "string" as const, enum: ["eth", "avax", "arbitrum"] },
      dst:      { type: "string" as const, enum: ["eth", "avax", "arbitrum"] },
      amount:   { type: "string" as const, description: "USDC amount in raw 6-decimal units" },
      walletId: { type: "string" as const, description: "Agentic Wallet ID" },
      feeToken: { type: "string" as const, enum: ["LINK", "native", "auto"], description: "Default: LINK" },
      sandbox:  { type: "boolean" as const, description: "Sandbox-only. Default true. Set to false for live bridge." },
    },
    required: ["src", "dst", "amount", "walletId"],
  },
};

export async function runBridgeSend(input: z.infer<typeof BridgeSendInputSchema>) {
  const sandbox = input.sandbox !== false;
  if (sandbox) {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          sandbox: true,
          messageId: "0x" + "00".repeat(32),
          txHash: "0x" + "00".repeat(32),
          note: "Sandbox response. To execute a real bridge, pass `sandbox: false` AND ensure the server has Q402_ENABLE_REAL_PAYMENTS=1.",
          src: input.src, dst: input.dst, amount: input.amount,
        }, null, 2),
      }],
    };
  }

  // Live mode — v1 deferred. /api/ccip/send requires intent-bound EIP-712
  // signature ("ccip.bridge" action) which the MCP CLI can't obtain on
  // its own; it must come from the dashboard or a doctor-bound session.
  // v0.8.2 ships bridge_send as sandbox-only — agents can plan and quote
  // but the actual execution happens via the dashboard for now. Live MCP
  // execution will land once session-binding is plumbed (planned 0.8.x).
  return {
    content: [{
      type: "text" as const,
      text: "Live CCIP bridge via MCP is not yet wired in v0.8.2 — agents can quote and plan via " +
            "q402_bridge_quote and q402_bridge_send (sandbox), but actual execution must happen via " +
            "https://q402.quackai.ai/dashboard for now. Live MCP execution lands in a follow-up release.",
    }],
    isError: true,
  };
}
