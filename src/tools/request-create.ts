/**
 * q402_request_create - publish a Q402 payment request (the receive side).
 *
 * Mode-C (apiKey) only. Creating a request moves NO funds - it publishes an
 * intent to RECEIVE money - so there is no confirm gate and a Trial key is
 * fine. Returns a shareable pay URL + req_ id. Anyone can then fulfill it:
 * a human via the /pay link, or another agent via q402_request_pay (which
 * settles gaslessly). The recipient defaults to the configured Agent Wallet,
 * so an agent can bill to itself with just an amount.
 *
 * Hits POST /api/request { apiKey, chain, token, amount, recipient, memo }.
 */

import { z } from "zod";
import { CONFIG } from "../config.js";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const AMOUNT_RE = /^\d+(\.\d{1,18})?$/;

export const RequestCreateInputSchema = z.object({
  amount: z
    .string()
    .regex(AMOUNT_RE)
    .describe('Amount to request, as a decimal string (e.g. "5", "1.50"). Counted in `token` (USDC or USDT, both USD-1).'),
  token: z
    .enum(["USDC", "USDT", "USDG"])
    .default("USDT")
    .describe("Stablecoin to be paid. USDC / USDT on most chains; USDG (Paxos Global Dollar) is Robinhood-Chain-only. All peg USD-1."),
  chain: z
    .enum(["bnb", "eth", "avax", "xlayer", "stable", "mantle", "injective", "monad", "scroll", "arbitrum", "base", "robinhood"])
    .default("bnb")
    .describe("Chain the request settles on. Defaults to bnb."),
  recipient: z
    .string()
    .regex(ADDRESS_RE)
    .optional()
    .describe("0x address that receives the funds. Defaults to Q402_AGENT_WALLET_ADDRESS (the agent bills itself) when omitted."),
  memo: z
    .string()
    .max(200)
    .optional()
    .describe("Optional note shown to the payer (≤200 chars), e.g. an invoice number or service description."),
  ttlDays: z
    .number()
    .int()
    .min(1)
    .max(90)
    .optional()
    .describe("Days until the request expires. Defaults to 7 (max 90)."),
});
export type RequestCreateInput = z.infer<typeof RequestCreateInputSchema>;

interface PublicRequest {
  id: string;
  recipient: string;
  chain: string;
  token: "USDC" | "USDT" | "USDG";
  amount: string;
  memo?: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  sandbox: boolean;
}

export interface RequestCreateResult {
  ok: boolean;
  requestId: string | null;
  payUrl: string | null;
  request: PublicRequest | null;
  error?: string;
  message?: string;
}

export async function runRequestCreate(input: RequestCreateInput): Promise<RequestCreateResult> {
  const base = CONFIG.relayBaseUrl;

  if (!CONFIG.apiKey) {
    return {
      ok: false,
      requestId: null,
      payUrl: null,
      request: null,
      error: "API_KEY_REQUIRED",
      message: "No Q402 API key configured. Run q402_doctor to set one up.",
    };
  }

  const recipient = input.recipient?.toLowerCase() ?? CONFIG.walletId;
  if (!recipient) {
    return {
      ok: false,
      requestId: null,
      payUrl: null,
      request: null,
      error: "RECIPIENT_REQUIRED",
      message:
        "No recipient given and no Q402_AGENT_WALLET_ADDRESS configured. Pass `recipient` " +
        "(the 0x address that should receive the funds).",
    };
  }

  try {
    const res = await fetch(`${base}/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: CONFIG.apiKey,
        chain: input.chain ?? "bnb",
        token: input.token ?? "USDT",
        amount: input.amount,
        recipient,
        ...(input.memo !== undefined ? { memo: input.memo } : {}),
        ...(input.ttlDays !== undefined ? { ttlDays: input.ttlDays } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => ({}))) as {
      requestId?: string;
      payUrl?: string;
      request?: PublicRequest;
      error?: string;
    };
    if (!res.ok || !data.requestId) {
      return {
        ok: false,
        requestId: null,
        payUrl: null,
        request: null,
        error: data.error ?? `HTTP_${res.status}`,
        message: data.error ?? `Create failed with HTTP ${res.status}.`,
      };
    }
    return {
      ok: true,
      requestId: data.requestId,
      payUrl: data.payUrl ?? null,
      request: data.request ?? null,
    };
  } catch (e) {
    return {
      ok: false,
      requestId: null,
      payUrl: null,
      request: null,
      error: "NETWORK_ERROR",
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

export const REQUEST_CREATE_TOOL = {
  name: "q402_request_create",
  description:
    "Publish a Q402 payment request (an invoice / bill). Moves no funds - it creates a shareable " +
    "request to RECEIVE money - so no confirmation is needed and a Trial key works. Returns a req_ id " +
    "+ a /pay link you can share with a human, or hand the requestId to another agent that pays it " +
    "gaslessly via q402_request_pay. The recipient defaults to your configured Agent Wallet, so you " +
    "can bill yourself with just an amount. Pair with q402_request_status to poll for payment.",
  inputSchema: {
    type: "object" as const,
    properties: {
      amount: {
        type: "string" as const,
        pattern: "^\\d+(\\.\\d{1,18})?$",
        description: 'Required. Amount to request as a decimal string (e.g. "5", "1.50").',
      },
      token: {
        type: "string" as const,
        enum: ["USDC", "USDT", "USDG"],
        description: "Default 'USDT'. USDG (Paxos Global Dollar) is Robinhood-Chain-only. All peg USD-1.",
      },
      chain: {
        type: "string" as const,
        enum: ["bnb", "eth", "avax", "xlayer", "stable", "mantle", "injective", "monad", "scroll", "arbitrum", "base", "robinhood"],
        description: "Default 'bnb'. Chain the request settles on.",
      },
      recipient: {
        type: "string" as const,
        pattern: "^0x[0-9a-fA-F]{40}$",
        description: "Optional 0x address to receive funds. Defaults to Q402_AGENT_WALLET_ADDRESS (bill yourself).",
      },
      memo: {
        type: "string" as const,
        maxLength: 200,
        description: "Optional note shown to the payer (≤200 chars).",
      },
      ttlDays: {
        type: "number" as const,
        minimum: 1,
        maximum: 90,
        description: "Days until expiry. Default 7.",
      },
    },
    required: ["amount"],
    additionalProperties: false,
  },
};
