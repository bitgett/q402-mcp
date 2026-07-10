/**
 * q402_oft_send — bridge USDT (USDT0) across chains via LayerZero OFT (Mode C).
 *
 * Companion to q402_bridge_send (USDC/CCIP). Moves the Agent Wallet's USDT0 from
 * one chain to the SAME wallet's address on another chain (recipient is always
 * self; "then pay Alice" is a separate q402_pay on the destination). Sandbox by
 * default; a live call needs sandbox:false + confirm:true + a matching
 * consentToken + a live Multichain key + Q402_ENABLE_REAL_PAYMENTS=1.
 */

import { z } from "zod";
import { CONFIG, resolveApiKey } from "../config.js";
import { checkConsent } from "../consent.js";

const OFT_CHAINS = ["eth", "arbitrum", "mantle", "monad", "xlayer"] as const;

export const OftSendInputSchema = z.object({
  src: z.enum(OFT_CHAINS).describe("Source chain"),
  dst: z.enum(OFT_CHAINS).describe("Destination chain (MUST differ from src)"),
  amount: z.string().regex(/^\d*[1-9]\d*$/).describe("USDT0 amount in raw local-decimal units, > 0 (6-decimal)"),
  walletId: z.string().optional().describe("Agent Wallet ID (from q402_agentic_info). Optional — defaults to the owner's default Agent Wallet."),
  maxFeeRaw: z.string().regex(/^\d+$/).optional().describe("Optional client-side native fee cap (raw 18-dec wei). Server still clamps to a 10% ceiling."),
  sandbox: z.boolean().optional().describe("Sandbox mode (default true). Set to false for a live on-chain bridge."),
  confirm: z.boolean().optional().describe("Must be true (with a matching consentToken) for a live bridge."),
  consentToken: z.string().optional().describe("Consent token echoed back from the preview to authorize a live bridge."),
}).refine(d => d.src !== d.dst, { message: "src must differ from dst", path: ["dst"] });

export const OFT_SEND_TOOL = {
  name: "q402_oft_send",
  description:
    "Bridge USDT (USDT0) across chains (eth/arbitrum/mantle/monad/xlayer) via LayerZero OFT, from the Agent " +
    "Wallet to the SAME wallet's address on the destination. Mode C (server-managed wallet). Sandbox-by-default; " +
    "a live bridge needs confirm:true + consentToken. For USDC use q402_bridge_send (CCIP).",
  inputSchema: {
    type: "object" as const,
    properties: {
      src: { type: "string" as const, enum: [...OFT_CHAINS], description: "Source chain." },
      dst: { type: "string" as const, enum: [...OFT_CHAINS], description: "Destination chain (MUST differ from src)." },
      amount: { type: "string" as const, pattern: "^[0-9]+$", description: "USDT0 amount in raw local-decimal units (6-decimal; '1000000' = 1 USDT0)." },
      walletId: { type: "string" as const, description: "Optional Agent Wallet id; defaults to the owner's default wallet." },
      maxFeeRaw: { type: "string" as const, pattern: "^[0-9]+$", description: "Optional native fee cap (raw 18-dec wei)." },
      sandbox: { type: "boolean" as const, description: "Sandbox mode (default true)." },
      confirm: { type: "boolean" as const, description: "Must be true for a live bridge." },
      consentToken: { type: "string" as const, description: "Consent token from the preview." },
    },
    required: ["src", "dst", "amount"],
  },
};

interface SandboxResponse { sandbox: true; guid: string; txHash: string; note: string; src: string; dst: string; amount: string; }
function sandbox(input: z.infer<typeof OftSendInputSchema>, note: string): SandboxResponse {
  return { sandbox: true, guid: "0x" + "00".repeat(32), txHash: "0x" + "00".repeat(32), note, src: input.src, dst: input.dst, amount: input.amount };
}

export async function runOftSend(input: z.infer<typeof OftSendInputSchema>) {
  // ── Sandbox by default ────────────────────────────────────────────────
  if (input.sandbox !== false) {
    return { content: [{ type: "text" as const, text: JSON.stringify(sandbox(input, "Sandbox response. Pass `sandbox: false` AND set Q402_ENABLE_REAL_PAYMENTS=1 (with a live Q402_MULTICHAIN_API_KEY) to fire a real USDT0 bridge."), null, 2) }] };
  }

  // ── Two-phase consent — LIVE bridge MOVES FUNDS ───────────────────────
  const consentIntent = {
    t: "oft",
    src: input.src,
    dst: input.dst,
    amount: input.amount,
    maxFeeRaw: input.maxFeeRaw ?? null,
    wid: (input.walletId ?? "").toLowerCase(),
  };
  const consent = checkConsent(consentIntent, input.consentToken);
  if (input.confirm !== true || !consent.ok) {
    const walletDesc = typeof input.walletId === "string" && input.walletId.length > 0 ? `wallet ${input.walletId.toLowerCase()}` : "your default Agent Wallet";
    return {
      content: [{
        type: "text" as const,
        text:
          `Will bridge ${input.amount} raw USDT0 units from ${input.src} -> ${input.dst} via LayerZero ` +
          `from ${walletDesc}, delivered to the same wallet on ${input.dst}. This MOVES FUNDS on-chain. ` +
          `Confirm with the user, then re-call with sandbox:false, confirm:true, AND consentToken="${consent.expected}".`,
      }],
    };
  }

  // ── Live mode gates ───────────────────────────────────────────────────
  const resolved = resolveApiKey(input.src, "multichain");
  if (!resolved.apiKey) {
    return { content: [{ type: "text" as const, text: JSON.stringify(sandbox(input, resolved.sandboxReason ?? "No live Multichain API key configured. Set Q402_MULTICHAIN_API_KEY to a q402_live_… key from https://q402.quackai.ai/payment."), null, 2) }] };
  }
  if (!resolved.apiKey.startsWith("q402_live_")) {
    return { content: [{ type: "text" as const, text: JSON.stringify(sandbox(input, "Resolved API key is not a live key. Set Q402_MULTICHAIN_API_KEY to a q402_live_… key."), null, 2) }] };
  }
  if (!CONFIG.realPaymentsRequested) {
    return { content: [{ type: "text" as const, text: JSON.stringify(sandbox(input, "Q402_ENABLE_REAL_PAYMENTS is not set to 1. Set the env var to fire a real bridge."), null, 2) }] };
  }

  const walletId = typeof input.walletId === "string" && input.walletId.length > 0 ? input.walletId.toLowerCase() : CONFIG.walletId ?? undefined;

  // ── Live request ──────────────────────────────────────────────────────
  let resp: Response;
  try {
    resp = await fetch(`${CONFIG.relayBaseUrl}/wallet/agentic/oft-bridge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: resolved.apiKey,
        ...(walletId ? { walletId } : {}),
        src: input.src,
        dst: input.dst,
        amount: input.amount,
        ...(input.maxFeeRaw ? { maxFeeRaw: input.maxFeeRaw } : {}),
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e) {
    return { content: [{ type: "text" as const, text: `Bridge request failed: ${e instanceof Error ? e.message : String(e)}. The bridge may or may not have fired — check q402_oft_history before retrying.` }], isError: true };
  }

  const data = (await resp.json()) as Record<string, unknown>;
  if (!resp.ok) {
    return { content: [{ type: "text" as const, text: `Bridge failed (HTTP ${resp.status}): ${JSON.stringify(data)}` }], isError: true };
  }
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
