/**
 * q402_bridge_history — list the agent's recent CCIP bridges.
 *
 * Returns the last 50 bridge records for the owner address. Requires the
 * owner-sig auth path (same as q402_gas_tank_status). The current
 * release ships without the owner-sig wiring from MCP — surface the
 * dashboard URL for now.
 */

import { z } from "zod";

export const BridgeHistoryInputSchema = z.object({
  ownerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional().describe("Owner EOA. Defaults to the configured Agentic Wallet owner."),
});

export const BRIDGE_HISTORY_TOOL = {
  name: "q402_bridge_history",
  description:
    "List the user's recent Chainlink CCIP bridges (most-recent first, up to 50 records). " +
    "Each record includes messageId, source/destination chains, USDC amount, fee paid, and " +
    "CCIP Explorer link. Returns dashboard URL guidance until owner-sig wiring lands in a follow-up.",
  inputSchema: {
    type: "object" as const,
    properties: {
      ownerAddress: {
        type: "string" as const,
        pattern: "^0x[0-9a-fA-F]{40}$",
        description: "Owner EOA (0x address, optional — defaults to configured wallet).",
      },
    },
  },
};

export async function runBridgeHistory(_input: z.infer<typeof BridgeHistoryInputSchema>) {
  // isError: true so an LLM doesn't parse the prose as a successful empty
  // array. We're explicitly saying "this surface isn't wired here yet".
  return {
    content: [{
      type: "text" as const,
      text: "Bridge history via MCP requires owner-sig auth, which is dashboard-managed at the current release. " +
            "View at https://q402.quackai.ai/dashboard → Agent tab → Bridge History.",
    }],
    isError: true,
  };
}
