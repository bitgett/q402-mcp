/**
 * q402_bridge_gas_tank — show LINK + native Gas Tank balance per CCIP chain.
 *
 * Lets the agent check whether the user has enough Gas Tank balance to fund
 * a bridge before committing. Returns LINK balance + native balance per of
 * the 3 CCIP chains (eth/avax/arbitrum). Surfaces deposit addresses for
 * top-ups.
 *
 * v0.8.2: read-only guidance — full balance fetch requires owner-sig auth
 * which lands in a follow-up release. Tool exists today so doctor/agents
 * can route users to the dashboard's Bridge Gas Tank section.
 */

import { z } from "zod";

export const BridgeGasTankInputSchema = z.object({
  ownerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional().describe("Owner EOA. Defaults to configured wallet."),
});

export const BRIDGE_GAS_TANK_TOOL = {
  name: "q402_bridge_gas_tank",
  description:
    "Report the user's Bridge Gas Tank state — LINK + native balance per CCIP chain (eth/avax/arbitrum). " +
    "Q402 charges no markup on bridges; users pay only the actual Chainlink CCIP fee, debited from this Gas Tank. " +
    "LINK fees are ~10% cheaper than native. Tool returns guidance + dashboard URL in v0.8.2.",
  inputSchema: {
    type: "object" as const,
    properties: {
      ownerAddress: { type: "string" as const, description: "Owner address (optional)" },
    },
  },
};

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
        "Top up by sending LINK or native to the Q402 facilitator address on the source chain. The next " +
        "deposit-scan cron tick (15 min) credits your Gas Tank.",
        "",
        "Live balance + deposit addresses: https://q402.quackai.ai/dashboard → Agent tab → Bridge Gas Tank",
      ].join("\n"),
    }],
  };
}
