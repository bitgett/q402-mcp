/**
 * q402_request_pay — pay a Q402 payment request from your own Agent Wallet.
 *
 * Mode-C (apiKey) gasless settlement: the server signs from the payer's
 * encrypted Agent Wallet key and relays for $0 gas. recipient / amount /
 * chain / token come from the stored request (the payer can't redirect or
 * change the sum). MOVES FUNDS, so it gates on confirm:true plus a live key
 * and Q402_ENABLE_REAL_PAYMENTS=1 — identical safety to q402_pay. The same
 * Q402_MAX_AMOUNT_PER_CALL + Q402_ALLOWED_RECIPIENTS rails apply.
 *
 * Flow: GET /api/request/{id} to resolve the terms, then
 * POST /api/request/{id}/pay { payerApiKey, walletId? } (server mode).
 */

import { z } from "zod";
import { CONFIG, resolveApiKey } from "../config.js";

export const RequestPayInputSchema = z.object({
  requestId: z
    .string()
    .regex(/^req_[0-9a-f]{24}$/, "requestId must match req_<24-hex>")
    .describe("The payment request to pay (req_ + 24 hex). Get it from a /pay link, a 402 response, or whoever billed you."),
  confirm: z
    .literal(true)
    .describe(
      "REQUIRED. Must be literally `true`. Paying a request moves real funds from your Agent " +
        "Wallet. Echo back the amount + token + recipient + chain from q402_request_status, get an " +
        "explicit user yes, and ONLY then call with confirm:true. Same guard as q402_pay.",
    ),
  walletId: z
    .string()
    .optional()
    .describe("Optional lowercased Agent Wallet address to pay from when you hold multiple. Defaults to Q402_AGENT_WALLET_ADDRESS, then the server default."),
});
export type RequestPayInput = z.infer<typeof RequestPayInputSchema>;

interface PublicRequest {
  id: string;
  recipient: string;
  chain: string;
  token: "USDC" | "USDT";
  amount: string;
  memo?: string;
  status: "open" | "paid" | "expired" | "cancelled";
  expiresAt: string;
  sandbox: boolean;
}

export interface RequestPayResult {
  ok: boolean;
  status: "paid" | "failed" | "not_payable" | "sandbox";
  requestId: string;
  txHash: string | null;
  receiptId: string | null;
  amount?: string;
  token?: string;
  chain?: string;
  recipient?: string;
  error?: string;
  message?: string;
  setupHint?: string;
}

export async function runRequestPay(input: RequestPayInput): Promise<RequestPayResult> {
  const base = CONFIG.relayBaseUrl;

  // 1. Resolve the request terms (server is the source of truth).
  let req: PublicRequest;
  try {
    const r = await fetch(`${base}/request/${input.requestId}`, { signal: AbortSignal.timeout(10_000) });
    if (r.status === 404) {
      return { ok: false, status: "not_payable", requestId: input.requestId, txHash: null, receiptId: null, error: "NOT_FOUND", message: "No request with that id." };
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    req = ((await r.json()) as { request: PublicRequest }).request;
  } catch (e) {
    return { ok: false, status: "failed", requestId: input.requestId, txHash: null, receiptId: null, error: "LOOKUP_FAILED", message: e instanceof Error ? e.message : String(e) };
  }

  const terms = { amount: req.amount, token: req.token, chain: req.chain, recipient: req.recipient };

  if (req.status !== "open") {
    return { ok: false, status: "not_payable", requestId: req.id, txHash: null, receiptId: null, ...terms, error: req.status.toUpperCase(), message: `Request is ${req.status} — nothing to pay.` };
  }

  // 2. Client-side rails (same as q402_pay / q402_request_create).
  const amountNum = Number(req.amount);
  if (Number.isFinite(amountNum) && amountNum > CONFIG.maxAmountPerCallUsd) {
    return { ok: false, status: "not_payable", requestId: req.id, txHash: null, receiptId: null, ...terms, error: "AMOUNT_EXCEEDS_CAP", message: `Request amount $${req.amount} exceeds your Q402_MAX_AMOUNT_PER_CALL cap of $${CONFIG.maxAmountPerCallUsd}.` };
  }
  if (CONFIG.allowedRecipients.length > 0 && !CONFIG.allowedRecipients.includes(req.recipient.toLowerCase())) {
    return { ok: false, status: "not_payable", requestId: req.id, txHash: null, receiptId: null, ...terms, error: "RECIPIENT_NOT_ALLOWED", message: `Recipient ${req.recipient} is not in Q402_ALLOWED_RECIPIENTS.` };
  }

  // 3. Resolve a LIVE key for the request's chain + require explicit opt-in.
  const resolved = resolveApiKey(req.chain, "auto");
  if (!resolved.apiKey || !resolved.apiKey.startsWith("q402_live_")) {
    return {
      ok: false,
      status: "sandbox",
      requestId: req.id,
      txHash: null,
      receiptId: null,
      ...terms,
      error: "LIVE_KEY_REQUIRED",
      message: "Paying a request settles real funds and needs a live Q402 API key.",
      setupHint: resolved.sandboxReason ?? "Configure a live Q402_MULTICHAIN_API_KEY (or Q402_TRIAL_API_KEY for BNB) to pay requests.",
    };
  }
  if (!CONFIG.realPaymentsRequested) {
    return {
      ok: false,
      status: "sandbox",
      requestId: req.id,
      txHash: null,
      receiptId: null,
      ...terms,
      error: "REAL_PAYMENTS_DISABLED",
      message: "Real payments are off, so this request was not paid.",
      setupHint: "Set Q402_ENABLE_REAL_PAYMENTS=1 to let q402_request_pay settle real funds.",
    };
  }

  const walletId =
    typeof input.walletId === "string" && input.walletId.length > 0
      ? input.walletId.toLowerCase()
      : CONFIG.walletId;

  // 4. Server-mode settle: the pay route signs from the payer's Agent Wallet,
  //    relays gaslessly, and marks the request paid atomically.
  try {
    const res = await fetch(`${base}/request/${req.id}/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payerApiKey: resolved.apiKey,
        ...(walletId ? { walletId } : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const data = (await res.json().catch(() => ({}))) as {
      status?: string;
      txHash?: string;
      receiptId?: string;
      error?: string;
      message?: string;
    };
    if (!res.ok || !data.txHash) {
      return { ok: false, status: "failed", requestId: req.id, txHash: null, receiptId: null, ...terms, error: data.error ?? `HTTP_${res.status}`, message: data.message ?? data.error ?? `Settlement failed (HTTP ${res.status}).` };
    }
    return { ok: true, status: "paid", requestId: req.id, txHash: data.txHash, receiptId: data.receiptId ?? null, ...terms };
  } catch (e) {
    return { ok: false, status: "failed", requestId: req.id, txHash: null, receiptId: null, ...terms, error: "NETWORK_ERROR", message: e instanceof Error ? e.message : String(e) };
  }
}

export const REQUEST_PAY_TOOL = {
  name: "q402_request_pay",
  description:
    "Pay a Q402 payment request from your own Agent Wallet, gaslessly. Give it a req_ id (from a " +
    "/pay link, a 402 Payment Required response, or whoever billed you) and it settles the exact " +
    "amount + token + recipient the request specifies — you cannot redirect or change them. MOVES " +
    "FUNDS: requires confirm:true, a live API key, and Q402_ENABLE_REAL_PAYMENTS=1, same as q402_pay. " +
    "Call q402_request_status first to show the user what they're paying. This is the agent-to-agent " +
    "billing path: agent A bills with q402_request_create, agent B settles here.",
  inputSchema: {
    type: "object" as const,
    properties: {
      requestId: {
        type: "string" as const,
        pattern: "^req_[0-9a-f]{24}$",
        description: "Required. The req_ id to pay.",
      },
      confirm: {
        type: "boolean" as const,
        const: true,
        description: "REQUIRED. Must be literally true. Paying moves real funds — get an explicit user yes first.",
      },
      walletId: {
        type: "string" as const,
        description: "Optional. Agent Wallet address to pay from. Defaults to the configured / server-default wallet.",
      },
    },
    required: ["requestId", "confirm"],
    additionalProperties: false,
  },
};
