/**
 * q402_bridge_gas_tank — show LINK + native Gas Tank balance per CCIP chain.
 *
 * Lets the agent check whether the user has enough Gas Tank balance to fund
 * a bridge before committing. Returns LINK balance + native balance per of
 * the 3 CCIP chains (eth/avax/arbitrum). Surfaces deposit addresses for
 * top-ups.
 *
 * Current release: read-only guidance — full balance fetch requires
 * owner-sig auth which lands in a follow-up. Tool exists today so
 * doctor/agents can route users to the dashboard's Bridge Gas Tank
 * section.
 */

import { z } from "zod";

export const BridgeGasTankInputSchema = z.object({
  ownerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional().describe("Owner EOA. Defaults to configured wallet."),
});

export const BRIDGE_GAS_TANK_TOOL = {
  name: "q402_bridge_gas_tank",
  description:
    "READ-ONLY GUIDANCE TOOL — Bridge Gas Tank live balance via MCP is not yet wired (requires " +
    "owner-sig auth which is dashboard-bound until session-binding lands, same follow-up as " +
    "q402_bridge_history). Tool returns static guidance: the LINK/native fee model, the 3-chain " +
    "CCIP triangle (eth/avax/arbitrum), the canonical Gas Tank deposit address, and a dashboard " +
    "pointer for the live balance and per-chain deposit detail. Use this to route a user to the " +
    "right top-up flow; don't expect numbers in the response.",
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

// Keep this in sync with `app/lib/wallets.ts` — GASTANK_ADDRESS is the
// single deposit sink for both Q402 settlement Gas Tank and Bridge Gas
// Tank top-ups. Drift here means users mis-route funds.
const GASTANK_ADDRESS = "0x10fb078594b70ee8024b2ded3d67fc3aa9ea747a";

export async function runBridgeGasTank(_input: z.infer<typeof BridgeGasTankInputSchema>) {
  return {
    content: [{
      type: "text" as const,
      text: [
        "Bridge Gas Tank covers Chainlink CCIP fees on the 3-chain triangle (eth/avax/arbitrum).",
        "",
        "Two fee tokens supported:",
        "  • LINK (default, ~10% cheaper)",
        "  • native (ETH / AVAX / ETH respectively)",
        "",
        `Top up by sending LINK or native to the Q402 Gas Tank address ${GASTANK_ADDRESS} on the ` +
        "source chain. The deposit-scan cron (every ~5 min) credits your Gas Tank automatically; the " +
        "dashboard's \"Verify\" button is the immediate self-serve path.",
        "",
        "Live balance + per-chain deposit detail: https://q402.quackai.ai/dashboard → Agent tab → Bridge Gas Tank",
      ].join("\n"),
    }],
  };
}
