/**
 * q402_yield_withdraw — WRITE / MOVES FUNDS. Withdraws the Agent Wallet's
 * supplied stablecoin out of Aave V3 (Q402 Yield) back to the Agent Wallet.
 *
 * Server-mediated (Mode C): authenticated by the live Multichain API key
 * sent in the JSON BODY, matching how the agentic pay/send path
 * authenticates. The server holds the Agent Wallet's encrypted key, signs
 * the Aave `withdraw`, and sponsors gas — the MCP never holds a private
 * key for this path.
 *
 * `amount` may be the literal string "max" to withdraw the FULL position.
 *
 * SAFETY GATE — mirrors q402_pay: this tool MOVES FUNDS, so it refuses to
 * execute unless `confirm === true`. When `confirm` is missing/false the
 * tool does NOT call the endpoint; it returns (NOT an error) a one-line
 * description of exactly what will happen and asks the agent to re-call
 * with confirm:true after the user approves.
 */

import { hexlify, randomBytes } from "ethers";
import { z } from "zod";
import { CONFIG, resolveApiKey } from "../config.js";

export const YieldWithdrawInputSchema = z.object({
  chain: z
    .enum(["bnb"])
    .default("bnb")
    .describe("Chain the Aave market lives on. Q402 Yield is BNB-only today — only 'bnb' is accepted."),
  token: z
    .enum(["USDC", "USDT"])
    .describe("Stablecoin to withdraw from Aave. USDC or USDT."),
  amount: z
    .string()
    .regex(/^(\d+(\.\d+)?|max)$/, 'amount must be a positive decimal string or "max"')
    .describe('Human-readable decimal amount to withdraw, e.g. "100.00", or the literal "max" to withdraw the full position.'),
  walletId: z
    .string()
    .optional()
    .describe(
      "Optional Agent Wallet address to withdraw to (max 10 per owner). " +
        "Omit to use Q402_AGENT_WALLET_ADDRESS env, then the owner's default " +
        "wallet (resolved server-side from the API key).",
    ),
  idempotencyKey: z
    .string()
    .optional()
    .describe(
      "Optional durable idempotency key for this logical withdrawal. When omitted the " +
        "tool generates a FRESH random key per invocation, so each call executes a " +
        "distinct withdrawal (a re-deposit followed by another `withdraw max` is NOT " +
        "replayed). Pass your own STABLE key only when you want retry-safety: re-calling " +
        "with the same key replays the first result instead of double-withdrawing.",
    ),
  confirm: z
    .boolean()
    .optional()
    .describe(
      "MUST be true to actually withdraw funds. Set this only after the user has " +
        "explicitly approved this exact withdrawal (amount, token, chain, wallet) in " +
        "the conversation. When omitted or false the tool previews the action and " +
        "does NOT move any funds.",
    ),
});

export const YIELD_WITHDRAW_TOOL = {
  name: "q402_yield_withdraw",
  description:
    "WRITE — MOVES FUNDS. Withdraws the Agent Wallet's supplied stablecoin (USDC / USDT) " +
    "out of Aave V3 (Q402 Yield) back to the Agent Wallet. Pass amount=\"max\" to withdraw " +
    "the FULL position. Server-managed Agent Wallet path (Mode C): authenticated by the " +
    "configured live Multichain API key — the server holds the encrypted key, signs the " +
    "Aave withdraw, and sponsors gas. " +
    "BNB CHAIN ONLY — Q402 Yield supports BNB Chain today; ETH / AVAX and other chains " +
    "are not yet available. " +
    "\n\n" +
    "REQUIRES CONFIRMATION — like q402_pay, this tool refuses to execute unless " +
    "`confirm: true` is set. Call it FIRST without confirm to get a one-line preview of " +
    "exactly what will happen (amount, token, chain, wallet); show that to the user, get " +
    "explicit approval, THEN re-call with confirm:true. Never set confirm:true on the " +
    "user's behalf without that approval. " +
    "\n\n" +
    "SANDBOX BY DEFAULT — like q402_pay, no funds move unless a live Multichain key " +
    "(q402_live_*) is configured AND Q402_ENABLE_REAL_PAYMENTS=1. Without both, " +
    "confirm:true returns a sandbox preview (no on-chain withdraw) with a setup hint — " +
    "confirm:true alone does NOT move real funds. " +
    "\n\n" +
    "Use q402_yield_positions first to see the current position size (especially before an " +
    "amount=\"max\" withdrawal).",
  inputSchema: {
    type: "object" as const,
    properties: {
      chain: {
        type: "string" as const,
        enum: ["bnb"],
        description: "Chain the Aave market lives on. Q402 Yield is BNB-only today — only 'bnb' is accepted.",
      },
      token: {
        type: "string" as const,
        enum: ["USDC", "USDT"],
        description: "Stablecoin to withdraw from Aave. USDC or USDT.",
      },
      amount: {
        type: "string" as const,
        description:
          'Human-readable decimal amount to withdraw, e.g. "100.00", or the literal "max" ' +
          "to withdraw the full position.",
      },
      walletId: {
        type: "string" as const,
        description:
          "Optional Agent Wallet address to withdraw to when the owner holds multiple " +
          "wallets. Defaults to Q402_AGENT_WALLET_ADDRESS env, then the owner's default " +
          "wallet on the server.",
      },
      idempotencyKey: {
        type: "string" as const,
        description:
          "Optional durable idempotency key. Omit and the tool generates a FRESH random " +
          "key per invocation, so every call executes a distinct withdrawal. Pass your own " +
          "STABLE key only for opt-in retry-safety — re-calling with the same key replays " +
          "the first result instead of double-withdrawing.",
      },
      confirm: {
        type: "boolean" as const,
        description:
          "MUST be true to actually withdraw funds — set only after the user explicitly " +
          "approved this exact withdrawal in chat. Omit (or false) to preview without moving funds.",
      },
    },
    required: ["token", "amount"],
    additionalProperties: false,
  },
};

interface WithdrawData {
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

export async function runYieldWithdraw(input: z.infer<typeof YieldWithdrawInputSchema>) {
  // Strictly-positive amount (unless the literal "max"). The schema regex
  // accepts "0" / "0.0" — a zero withdraw is a no-op gas burn, so reject it.
  if (input.amount !== "max" && !(Number(input.amount) > 0)) {
    return {
      content: [{
        type: "text" as const,
        text: `amount must be greater than zero (got "${input.amount}"), or the literal "max".`,
      }],
      isError: true,
    };
  }

  // Resolution order: tool input → Q402_AGENT_WALLET_ADDRESS env → server
  // default (omit walletId so the route resolves the apiKey owner's default).
  const walletId =
    typeof input.walletId === "string" && input.walletId.length > 0
      ? input.walletId.toLowerCase()
      : CONFIG.walletId ?? undefined;

  // Idempotency key. The server keys a no-TTL "settled" marker on this, so a
  // PARAM-DERIVED default would be permanent: re-deposit then `withdraw max`
  // again with the same (walletId, chain, token, amount) would replay the OLD
  // txHash forever and the second withdrawal would never run. So the default
  // is a FRESH random 32-byte key per invocation: each distinct call executes.
  // A caller who wants retry-safety can still pass an explicit STABLE key
  // (opt-in) to dedupe a lost-response retry without double-withdrawing.
  const idempotencyKey =
    typeof input.idempotencyKey === "string" && input.idempotencyKey.length > 0
      ? input.idempotencyKey
      : hexlify(randomBytes(32));

  // "max" withdraws the full position — phrase the preview accordingly so the
  // user understands the whole balance is leaving Aave.
  const amountDesc = input.amount === "max" ? "the FULL position" : `${input.amount} ${input.token}`;

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
          `Will withdraw ${amountDesc} from Aave on ${input.chain} back to ` +
          `${walletDesc}. This MOVES FUNDS. Re-call with confirm:true to execute.`,
      }],
    };
  }

  // Yield withdraw is a Multichain-scope write; the resolver returns the live
  // Multichain key (or legacy fallback). apiKey travels in the BODY, matching
  // the Mode C send path.
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

  // ── Real-payments gate — mirrors q402_pay's Mode C path ──────────────────
  // A live key + confirm:true is NOT enough to move real funds. Like
  // q402_pay, this server-mediated write also requires Q402_ENABLE_REAL_PAYMENTS=1.
  // Without it we return a sandbox preview (no /api call, no on-chain withdraw)
  // so confirm:true alone can never move money when real payments are off.
  if (!CONFIG.realPaymentsRequested) {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          sandbox: true,
          success: false,
          status: "sandbox",
          action: "yield_withdraw",
          chain: input.chain,
          token: input.token,
          amount: input.amount,
          walletId: walletId ?? null,
          setupHint:
            "Sandbox mode — set Q402_ENABLE_REAL_PAYMENTS=1 to fire a real Q402 Yield " +
            "withdrawal. No funds moved.",
        }, null, 2),
      }],
    };
  }

  let res: Response;
  try {
    // 60s timeout — the route signs + withdraws + settles synchronously (same
    // posture as the Mode C send path). Fail fast on a stuck Vercel cold-start
    // rather than hang the MCP client.
    res = await fetch(`${CONFIG.relayBaseUrl}/wallet/agentic/yield/withdraw`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: resolved.apiKey,
        chain: input.chain,
        token: input.token,
        amount: input.amount,
        idempotencyKey,
        ...(walletId ? { walletId } : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    return {
      content: [{
        type: "text" as const,
        text: `Yield withdraw failed: ${e instanceof Error ? e.message : String(e)}. Retry in a moment.`,
      }],
      isError: true,
    };
  }

  const data = (await res.json().catch(() => ({}))) as WithdrawData;
  if (!res.ok) {
    return {
      content: [{
        type: "text" as const,
        text: `Yield withdraw failed (HTTP ${res.status}): ${JSON.stringify(data)}`,
      }],
      isError: true,
    };
  }

  const summary = data.txHash
    ? `Withdrew ${data.amount ?? amountDesc} ${data.asset ?? ""}`.trimEnd() +
      ` from ${data.protocol ?? "Aave"} on ${data.chain ?? input.chain}. txHash ${data.txHash}.`
    : `Yield withdraw submitted on ${data.chain ?? input.chain}.`;

  return {
    content: [
      { type: "text" as const, text: summary },
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}
