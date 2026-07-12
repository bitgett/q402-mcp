/**
 * q402_oft_history - list the agent's recent USDT0 (LayerZero OFT) bridges.
 *
 * Companion to q402_bridge_history (CCIP / USDC). Owner-sig auth is dashboard-bound
 * until session-binding lands, so this returns a pointer for now (same follow-up as
 * live q402_oft_send). q402_oft_send points a caller here when a live bridge request
 * errors and its on-chain status is uncertain.
 */

import { z } from "zod";

export const OftHistoryInputSchema = z.object({
  ownerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional().describe("Owner EOA. Defaults to the configured Agent Wallet owner."),
});

export const OFT_HISTORY_TOOL = {
  name: "q402_oft_history",
  description:
    "READ-ONLY GUIDANCE TOOL - USDT0 (LayerZero OFT) bridge history via MCP is not yet " +
    "wired in this release. It requires owner-sig auth which is dashboard-bound until " +
    "session-binding lands (same follow-up as live q402_oft_send). Returns a dashboard " +
    "pointer and intentionally reports implemented:false so an LLM does not read the prose " +
    "as an empty result. Future shape (finalized): most-recent-first list of up to 50 OFT " +
    "bridges with guid, source/destination chains, USDT0 amount, native fee paid, and a " +
    "LayerZero Scan link. For USDC/CCIP use q402_bridge_history.",
  inputSchema: {
    type: "object" as const,
    properties: {
      ownerAddress: {
        type: "string" as const,
        pattern: "^0x[0-9a-fA-F]{40}$",
        description: "Owner EOA (0x address, optional - defaults to configured wallet).",
      },
    },
  },
};

export async function runOftHistory(_input: z.infer<typeof OftHistoryInputSchema>) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        implemented: false,
        reason:
          "OFT bridge history via MCP requires owner-sig auth, which is dashboard-bound " +
          "until session-binding lands in a follow-up release.",
        dashboardUrl: "https://q402.quackai.ai/dashboard",
        dashboardPath: "Agent tab -> Bridge History",
      }, null, 2),
    }],
  };
}
