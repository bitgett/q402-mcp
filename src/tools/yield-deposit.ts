/**
 * q402_yield_deposit — WRITE / MOVES FUNDS. Supplies the Agent Wallet's
 * stablecoin into Aave V3 (Q402 Yield) so it starts earning supply APY.
 *
 * Server-mediated (Mode C): authenticated by the live Multichain API key
 * sent in the JSON BODY, matching how the agentic pay/send path
 * authenticates. The server holds the Agent Wallet's encrypted key, signs
 * the Aave `supply`, and auto-funds source-chain gas — the MCP never holds
 * a private key for this path.
 *
 * SAFETY GATE — mirrors q402_pay: this tool MOVES FUNDS, so it refuses to
 * execute unless `confirm === true`. When `confirm` is missing/false the
 * tool does NOT call the endpoint; it returns (NOT an error) a one-line
 * description of exactly what will happen and asks the agent to re-call
 * with confirm:true after the user approves.
 */

import { z } from "zod";
import { CONFIG, resolveApiKey } from "../config.js";

export const YieldDepositInputSchema = z.object({
  chain: z
    .string()
    .default("bnb")
    .describe("Chain slug the Aave market lives on (e.g. 'bnb', 'eth', 'avax'). Defaults to 'bnb'."),
  token: z
    .enum(["USDC", "USDT"])
    .describe("Stablecoin to supply into Aave. USDC or USDT."),
  amount: z
    .string()
    .regex(/^\d+(\.\d+)?$/, "amount must be a positive decimal string")
    .describe('Human-readable decimal amount to supply, e.g. "100.00".'),
  walletId: z
    .string()
    .optional()
    .describe(
      "Optional Agent Wallet address to supply from (max 10 per owner). " +
        "Omit to use Q402_AGENT_WALLET_ADDRESS env, then the owner's default " +
        "wallet (resolved server-side from the API key).",
    ),
  confirm: z
    .boolean()
    .optional()
    .describe(
      "MUST be true to actually supply funds. Set this only after the user has " +
        "explicitly approved this exact deposit (amount, token, chain, wallet) in " +
        "the conversation. When omitted or false the tool previews the action and " +
        "does NOT move any funds.",
    ),
});

export const YIELD_DEPOSIT_TOOL = {
  name: "q402_yield_deposit",
  description:
    "WRITE — MOVES FUNDS. Supplies the Agent Wallet's stablecoin (USDC / USDT) into " +
    "Aave V3 (Q402 Yield) so it starts earning supply APY. Server-managed Agent Wallet " +
    "path (Mode C): authenticated by the configured live Multichain API key — the server " +
    "holds the encrypted key, signs the Aave supply, and sponsors gas. " +
    "\n\n" +
    "REQUIRES CONFIRMATION — like q402_pay, this tool refuses to execute unless " +
    "`confirm: true` is set. Call it FIRST without confirm to get a one-line preview of " +
    "exactly what will happen (amount, token, chain, wallet); show that to the user, get " +
    "explicit approval, THEN re-call with confirm:true. Never set confirm:true on the " +
    "user's behalf without that approval. " +
    "\n\n" +
    "Use q402_yield_reserves first to show available markets + APY, and q402_yield_positions " +
    "afterward to confirm the supplied balance.",
  inputSchema: {
    type: "object" as const,
    properties: {
      chain: {
        type: "string" as const,
        description: "Chain slug the Aave market lives on (e.g. 'bnb', 'eth', 'avax'). Defaults to 'bnb'.",
      },
      token: {
        type: "string" as const,
        enum: ["USDC", "USDT"],
        description: "Stablecoin to supply into Aave. USDC or USDT.",
      },
      amount: {
        type: "string" as const,
        description: 'Human-readable decimal amount to supply, e.g. "100.00".',
      },
      walletId: {
        type: "string" as const,
        description:
          "Optional Agent Wallet address to supply from when the owner holds multiple " +
          "wallets. Defaults to Q402_AGENT_WALLET_ADDRESS env, then the owner's default " +
          "wallet on the server.",
      },
      confirm: {
        type: "boolean" as const,
        description:
          "MUST be true to actually supply funds — set only after the user explicitly " +
          "approved this exact deposit in chat. Omit (or false) to preview without moving funds.",
      },
    },
    required: ["token", "amount"],
    additionalProperties: false,
  },
};

interface DepositData {
  status?: string;
  action?: string;
  protocol?: string;
  chain?: string;
  asset?: string;
  amount?: string;
  pool?: string;
  txHash?: string;
  error?: string;
  message?: string;
}

export async function runYieldDeposit(input: z.infer<typeof YieldDepositInputSchema>) {
  // Resolution order: tool input → Q402_AGENT_WALLET_ADDRESS env → server
  // default (omit walletId so the route resolves the apiKey owner's default).
  const walletId =
    typeof input.walletId === "string" && input.walletId.length > 0
      ? input.walletId.toLowerCase()
      : CONFIG.walletId ?? undefined;

  // ── Confirm gate — MOVES FUNDS, so refuse without explicit approval ──────
  // Mirrors q402_pay: when confirm !== true we DO NOT hit the endpoint. We
  // return a plain (non-error) preview the agent must show the user before
  // re-calling with confirm:true.
  if (input.confirm !== true) {
    const walletDesc = walletId ? `wallet ${walletId}` : "your default Agent Wallet";
    return {
      content: [{
        type: "text" as const,
        text:
          `Will supply ${input.amount} ${input.token} into Aave on ${input.chain} from ` +
          `${walletDesc}. This MOVES FUNDS. Re-call with confirm:true to execute.`,
      }],
    };
  }

  // Yield supply is a Multichain-scope write (Aave lanes are non-BNB-only
  // sponsored); the resolver returns the live Multichain key (or legacy
  // fallback). apiKey travels in the BODY, matching the Mode C send path.
  const resolved = resolveApiKey(input.chain, "multichain");
  if (!resolved.apiKey || !resolved.apiKey.startsWith("q402_live_")) {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          configured: false,
          status: "error",
          setupHint:
            resolved.sandboxReason ??
            "No live Q402 Multichain API key configured. Set Q402_MULTICHAIN_API_KEY to a " +
              "q402_live_… key from https://q402.quackai.ai/payment, or run q402_doctor.",
        }, null, 2),
      }],
      isError: true,
    };
  }

  let res: Response;
  try {
    // 60s timeout — the route signs + supplies + settles synchronously (same
    // posture as the Mode C send path). Fail fast on a stuck Vercel cold-start
    // rather than hang the MCP client.
    res = await fetch(`${CONFIG.relayBaseUrl}/wallet/agentic/yield/deposit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: resolved.apiKey,
        chain: input.chain,
        token: input.token,
        amount: input.amount,
        ...(walletId ? { walletId } : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    return {
      content: [{
        type: "text" as const,
        text: `Yield deposit failed: ${e instanceof Error ? e.message : String(e)}. Retry in a moment.`,
      }],
      isError: true,
    };
  }

  const data = (await res.json().catch(() => ({}))) as DepositData;
  if (!res.ok) {
    return {
      content: [{
        type: "text" as const,
        text: `Yield deposit failed (HTTP ${res.status}): ${JSON.stringify(data)}`,
      }],
      isError: true,
    };
  }

  const summary = data.txHash
    ? `Supplied ${data.amount ?? input.amount} ${data.asset ?? input.token} into ` +
      `${data.protocol ?? "Aave"} on ${data.chain ?? input.chain}. txHash ${data.txHash}.`
    : `Yield deposit submitted on ${data.chain ?? input.chain}.`;

  return {
    content: [
      { type: "text" as const, text: summary },
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}
