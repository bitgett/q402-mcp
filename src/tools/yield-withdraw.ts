/**
 * q402_yield_withdraw — WRITE / MOVES FUNDS. Withdraws the Agent Wallet's
 * supplied stablecoin out of a curated lending venue (Q402 Yield) back to the Agent Wallet.
 *
 * Server-mediated (Mode C): authenticated by the live Multichain API key
 * sent in the JSON BODY, matching how the agentic pay/send path
 * authenticates. The server holds the Agent Wallet's encrypted key, signs
 * the venue `withdraw`, and sponsors gas — the MCP never holds a private
 * key for this path.
 *
 * `amount` may be the literal "max" to withdraw the max currently redeemable (may be < full position under vault caps).
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
import { checkConsent } from "../consent.js";

export const YieldWithdrawInputSchema = z.object({
  chain: z
    .enum(["bnb", "base"])
    .default("bnb")
    .describe("Chain to withdraw on. 'bnb' (USDC or USDT) or 'base' (USDC only). The venue is the chain's curated lending market; the actual venue is reported in the receipt."),
  token: z
    .enum(["USDC", "USDT"])
    .describe("Stablecoin to withdraw. USDC or USDT on bnb; USDC only on base."),
  amount: z
    .string()
    .regex(/^(\d+(\.\d+)?|max)$/, 'amount must be a positive decimal string or "max"')
    .describe('Human-readable decimal amount to withdraw, e.g. "100.00", or "max" to withdraw the maximum currently redeemable (can be less than the full position when the vault caps liquidity).'),
  protocol: z
    .enum(["aave", "morpho", "lista"])
    .optional()
    .describe(
      "Venue to withdraw from when the wallet holds the SAME token in more than one lending " +
        "venue on a chain (e.g. a legacy Aave position AND a Lista position on bnb). Omit when " +
        'unambiguous. If the server replies error="AMBIGUOUS_POSITION" it lists the venues in ' +
        "`protocols` — re-call with one of those values here.",
    ),
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
        "with the same key replays the first result instead of double-withdrawing. " +
        'IMPORTANT: if a call returns status="uncertain" (timeout / unconfirmed ' +
        "broadcast), it echoes back the idempotencyKey it used — pass THAT exact value " +
        "here to safely resume the same withdrawal instead of starting a new one.",
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
  consentToken: z
    .string()
    .optional()
    .describe(
      "Two-phase consent. LEAVE UNSET on the first call: the tool previews the " +
        "withdrawal (no funds move) and returns a consentToken. Relay the preview to " +
        "the user, get an explicit yes, then re-call with confirm:true AND this " +
        "consentToken. The token is re-derived from (chain, token, amount, wallet).",
    ),
});

export const YIELD_WITHDRAW_TOOL = {
  name: "q402_yield_withdraw",
  description:
    "WRITE — MOVES FUNDS. Withdraws the Agent Wallet's supplied stablecoin (USDC / USDT) " +
    "out of its Q402 Yield lending position back to the Agent Wallet. Pass amount=\"max\" to " +
    "withdraw the maximum currently redeemable (can be < full position under vault caps). Server-managed Agent Wallet path (Mode C): authenticated by the " +
    "configured live Multichain API key — the server holds the encrypted key, signs the " +
    "withdraw, and sponsors gas. " +
    "CHAINS: 'bnb' (USDC or USDT); 'base' (USDC only). The venue is the chain's curated lending " +
    "market and is reported in the receipt. " +
    "Other chains are not yet available. " +
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
    "RETRY SAFETY — on a timeout or an unconfirmed broadcast the tool returns " +
    'status="uncertain" and echoes back the idempotencyKey it used. The withdrawal MAY ' +
    "have settled, so do NOT blindly call again — that starts a NEW withdrawal and can " +
    "double-withdraw. To resume the SAME operation, re-call with idempotencyKey set to " +
    "the echoed value; the server dedupes on it and replays the original result. " +
    "\n\n" +
    "Use q402_yield_positions first to see the current position size (especially before an " +
    "amount=\"max\" withdrawal).",
  inputSchema: {
    type: "object" as const,
    properties: {
      chain: {
        type: "string" as const,
        enum: ["bnb", "base"],
        description: "Chain to withdraw on. 'bnb' (USDC or USDT) or 'base' (USDC only). The actual venue is reported in the receipt.",
      },
      token: {
        type: "string" as const,
        enum: ["USDC", "USDT"],
        description: "Stablecoin to withdraw. USDC or USDT on bnb; USDC only on base.",
      },
      amount: {
        type: "string" as const,
        description:
          'Human-readable decimal amount to withdraw, e.g. "100.00", or the literal "max" ' +
          "to withdraw the maximum currently redeemable (can be < full position under vault liquidity caps).",
      },
      protocol: {
        type: "string" as const,
        enum: ["aave", "morpho", "lista"],
        description:
          "Venue to withdraw from when the wallet holds the same token in more than one lending " +
          'venue on a chain. Omit when unambiguous; on an "AMBIGUOUS_POSITION" error re-call with ' +
          "one of the `protocols` the server lists.",
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
          "the first result instead of double-withdrawing. If a call returns " +
          'status="uncertain", it echoes the idempotencyKey it used — pass that exact ' +
          "value back here to resume the same withdrawal rather than start a new one.",
      },
      confirm: {
        type: "boolean" as const,
        description:
          "MUST be true to actually withdraw funds — set only after the user explicitly " +
          "approved this exact withdrawal in chat. Omit (or false) to preview without moving funds.",
      },
      consentToken: {
        type: "string" as const,
        description:
          "Two-phase consent token. Leave unset on the first call to get a preview + token; " +
          "re-call with confirm:true AND this token after the user approves. Bound to " +
          "(chain, token, amount, wallet).",
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
  /** Set on a 409 AMBIGUOUS_POSITION — the venues holding this token on the chain;
   *  re-call with `protocol` set to one of them. */
  protocols?: string[];
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

  // Base yield routes to the curated Morpho USDC vault (USDC only). Reject
  // USDT on base before any network call so the user gets a clear hint.
  if (input.chain === "base" && input.token !== "USDC") {
    return {
      content: [{
        type: "text" as const,
        text: `Base yield (Morpho) supports USDC only, not ${input.token}. Use chain "bnb" for USDT yield.`,
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
  // user understands the whole balance is leaving the lending venue.
  const amountDesc = input.amount === "max" ? "the maximum currently redeemable" : `${input.amount} ${input.token}`;

  // ── Two-phase consent gate — MOVES FUNDS ────────────────────────────────
  // Requires BOTH confirm:true AND a consentToken bound to the withdrawal
  // intent, so confirm:true alone can't move funds and the previewed params
  // are the ones that execute.
  const consentIntent = {
    t: "yield-withdraw",
    chain: input.chain,
    token: input.token,
    amount: input.amount,
    // Bind the venue into the consent token so an approved "withdraw from <venue>"
    // can't be re-called against a different venue (the token is re-derived from
    // these fields and refused on mismatch). null when unspecified (single-venue).
    protocol: input.protocol ?? null,
    walletId: walletId ?? null,
  };
  const consent = checkConsent(consentIntent, input.consentToken);
  if (input.confirm !== true || !consent.ok) {
    const walletDesc = walletId ? `wallet ${walletId}` : "your default Agent Wallet";
    return {
      content: [{
        type: "text" as const,
        text:
          `Will withdraw ${amountDesc} from your lending position on ${input.chain} back to ` +
          `${walletDesc}. This MOVES FUNDS. Confirm with the user, then re-call with ` +
          `confirm:true AND consentToken="${consent.expected}".`,
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
        ...(input.protocol ? { protocol: input.protocol } : {}),
        ...(walletId ? { walletId } : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    // NETWORK-UNCERTAIN — the request may or may not have reached the server
    // (timeout, dropped socket, cold-start). The withdrawal could already be
    // in flight or settled. We MUST NOT let the caller retry with a fresh
    // random key — that would be a NEW withdrawal (double-withdraw, e.g. two
    // `withdraw max`). Surface THIS call's idempotencyKey so a retry passing
    // it back resumes the SAME logical withdrawal (the server dedupes on it)
    // instead of starting another.
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          status: "uncertain",
          success: false,
          action: "yield_withdraw",
          chain: input.chain,
          token: input.token,
          amount: input.amount,
          idempotencyKey,
          error: e instanceof Error ? e.message : String(e),
          message:
            "Network error before a confirmed response — the withdrawal may or may not " +
            "have been submitted. Do NOT start a new withdrawal. To safely resume THIS " +
            `operation, retry with idempotencyKey="${idempotencyKey}" (the server dedupes ` +
            "on it, so a retry that already landed replays the original result instead of " +
            "double-withdrawing).",
        }, null, 2),
      }],
      isError: true,
    };
  }

  const data = (await res.json().catch(() => ({}))) as WithdrawData;
  if (!res.ok) {
    // 502 settlement_uncertain — the tx was broadcast but the receipt is
    // unconfirmed; the funds MAY have moved. Same rule as the network-error
    // path: a retry must reuse THIS idempotencyKey, never a fresh one, or it
    // risks a second on-chain withdrawal. Surface the key + the no-blind-retry
    // guidance. (Other non-2xx codes — 402/403/409/429/503 — are clean
    // pre-settlement rejections where no funds moved; the server already
    // explains them, so we pass the body through unchanged.)
    if (res.status === 502) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "uncertain",
            success: false,
            action: "yield_withdraw",
            chain: input.chain,
            token: input.token,
            amount: input.amount,
            idempotencyKey,
            txHash: data.txHash ?? null,
            error: data.error ?? "settlement_uncertain",
            message:
              "Broadcast but unconfirmed — the withdrawal may have settled on-chain. Do NOT " +
              "blindly start a new withdrawal. Verify on-chain first; if you must retry, reuse " +
              `idempotencyKey="${idempotencyKey}" so the server resumes THIS operation ` +
              "(replays the original result) instead of withdrawing again.",
          }, null, 2),
        }],
        isError: true,
      };
    }
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
      ` from ${data.protocol ?? "the lending vault"} on ${data.chain ?? input.chain}. txHash ${data.txHash}.`
    : `Yield withdraw submitted on ${data.chain ?? input.chain}.`;

  return {
    content: [
      { type: "text" as const, text: summary },
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}
