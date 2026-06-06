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

export const BridgeSendInputSchema = z.object({
  src: z.enum(["eth", "avax", "arbitrum"]).describe("Source chain"),
  dst: z.enum(["eth", "avax", "arbitrum"]).describe("Destination chain"),
  // `^\d+$` accepts "0" which is a no-op bridge. Require at least one
  // non-zero digit (^\d*[1-9]\d*$ also accepts e.g. "10", "100") so an
  // accidental amount=0 fails locally instead of returning a synthetic
  // "success" envelope in sandbox.
  amount: z.string().regex(/^\d*[1-9]\d*$/).describe("USDC amount in raw 6-decimal units, > 0"),
  walletId: z.string().describe("Agentic Wallet ID (from q402_agentic_info)"),
  feeToken: z.enum(["LINK", "native", "auto"]).optional().describe("Fee token. 'auto' picks cheaper of the two; defaults to LINK."),
  sandbox: z.boolean().optional().describe("Sandbox mode (default true). Set to false for live bridge."),
}).refine(d => d.src !== d.dst, {
  // Local Zod rejection saves a network round-trip + a Q402 backend log
  // entry. The /api/ccip/send route also rejects same-chain bridges but
  // the agent only finds out after burning a request.
  message: "src must differ from dst",
  path: ["dst"],
});

export const BRIDGE_SEND_TOOL = {
  name: "q402_bridge_send",
  description:
    "PLAN-AND-QUOTE TOOL (sandbox-only at this release). Execute a Chainlink CCIP USDC bridge plan " +
    "between two of the 3 supported chains (eth/avax/arbitrum). Returns a synthetic messageId so the " +
    "agent can preview the bridge end-to-end without moving funds. LIVE EXECUTION via MCP is NOT yet " +
    "wired — it requires an owner-EIP-712 signature on the `ccip.bridge` intent which the MCP CLI " +
    "cannot produce (the dashboard or a future session-binding flow is the live path). Calling with " +
    "`sandbox: false` returns isError:true regardless of Q402_ENABLE_REAL_PAYMENTS. Recommended flow: " +
    "q402_bridge_quote → show user the cost → if they want to bridge live, point them at " +
    "https://q402.quackai.ai/dashboard → Agent tab → Bridge.",
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
        description: "Destination chain (MUST differ from src).",
      },
      amount: {
        type: "string" as const,
        pattern: "^[0-9]+$",
        description: "USDC amount in raw 6-decimal units (e.g. '1000000' = 1 USDC). Integer string only.",
      },
      walletId: {
        type: "string" as const,
        description: "Agentic Wallet ID (from q402_agentic_info).",
      },
      feeToken: {
        type: "string" as const,
        enum: ["LINK", "native", "auto"],
        description: "Fee token. Default: LINK (~10% cheaper). 'auto' picks cheaper at quote time.",
      },
      sandbox: {
        type: "boolean" as const,
        description: "Sandbox-only at the current release. Passing false returns isError:true with a pointer to the dashboard's Bridge UI — live MCP execution lands once session-binding is plumbed.",
      },
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

  // Live mode — deferred. /api/ccip/send requires intent-bound EIP-712
  // signature ("ccip.bridge" action) which the MCP CLI can't obtain on
  // its own; it must come from the dashboard or a doctor-bound session.
  // bridge_send currently ships as sandbox-only — agents can plan and
  // quote but the actual execution happens via the dashboard. Live MCP
  // execution will land once session-binding is plumbed.
  return {
    content: [{
      type: "text" as const,
      text: "Live CCIP bridge via MCP is not yet wired — agents can quote and plan via " +
            "q402_bridge_quote and q402_bridge_send (sandbox), but actual execution must happen via " +
            "https://q402.quackai.ai/dashboard for now. Live MCP execution lands in a follow-up release.",
    }],
    isError: true,
  };
}
