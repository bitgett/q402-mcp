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
    "READ-ONLY GUIDANCE TOOL — bridge history via MCP is not yet wired in this release. It " +
    "requires owner-sig auth which is dashboard-bound until session-binding lands (same " +
    "follow-up as live q402_bridge_send). This tool returns a pointer to the dashboard " +
    "and intentionally surfaces as an error so an LLM does not interpret the prose as an " +
    "empty result. Future shape (already finalized): most-recent-first list of up to 50 " +
    "CCIP bridges with messageId, source/destination chains, USDC amount, fee paid, and " +
    "CCIP Explorer link. Until then, point the user at https://q402.quackai.ai/dashboard " +
    "→ Agent tab → Bridge History.",
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
  // Return a structured JSON envelope rather than isError:true. MCP
  // `isError` is reserved for actual execution failures; some agent
  // frameworks (Codex CLI's plugin runner, LangGraph) treat it as a
  // tool-failed signal and abort multi-step plans. The `implemented:
  // false` envelope lets the LLM distinguish "not yet wired" from
  // "real execution error" without the abort side-effect, and keeps
  // the empty-result confusion away (an LLM seeing a JSON `bridges:
  // null` plus `implemented: false` will not interpret it as "the
  // user has zero bridges").
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        implemented: false,
        reason:
          "Bridge history via MCP requires owner-sig auth, which is dashboard-bound until " +
          "session-binding lands in a follow-up release.",
        dashboardUrl: "https://q402.quackai.ai/dashboard",
        dashboardPath: "Agent tab → Bridge History",
      }, null, 2),
    }],
  };
}
