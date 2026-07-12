/**
 * q402_request_status - look up a Q402 payment request by its req_ id.
 *
 * Read-only, no API key. Returns the payer-facing projection (amount, token,
 * chain, recipient, status, expiry). Use it to poll whether a request you
 * created has been paid, or to inspect a requestId someone shared before
 * paying it with q402_request_pay. Mirrors q402_receipt's id-lookup shape:
 * a missing/expired id returns `notFound: true` rather than throwing.
 */

import { z } from "zod";
import { CONFIG } from "../config.js";

export const RequestStatusInputSchema = z.object({
  requestId: z
    .string()
    .regex(/^req_[0-9a-f]{24}$/, "requestId must match req_<24-hex>")
    .describe("Payment request id (req_ + 24 hex chars). Returned by q402_request_create; also the tail of any /pay/ URL."),
});
export type RequestStatusInput = z.infer<typeof RequestStatusInputSchema>;

interface PublicRequest {
  id: string;
  recipient: string;
  chain: string;
  token: "USDC" | "USDT";
  amount: string;
  memo?: string;
  status: "open" | "paid" | "expired" | "cancelled";
  createdAt: string;
  expiresAt: string;
  paidTxHash?: string;
  paidAt?: string;
  sandbox: boolean;
}

export interface RequestStatusResult {
  found: boolean;
  request: PublicRequest | null;
  payUrl: string | null;
  notFound?: boolean;
}

export async function runRequestStatus(input: RequestStatusInput): Promise<RequestStatusResult> {
  const base = CONFIG.relayBaseUrl;
  const pageBase = base.replace(/\/api\/?$/, "");

  const resp = await fetch(`${base}/request/${input.requestId}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (resp.status === 404) {
    return { found: false, request: null, payUrl: null, notFound: true };
  }
  if (!resp.ok) {
    throw new Error(`request status fetch failed: HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as { request: PublicRequest };
  return {
    found: true,
    request: data.request,
    payUrl: `${pageBase}/pay/${data.request.id}`,
  };
}

export const REQUEST_STATUS_TOOL = {
  name: "q402_request_status",
  description:
    "Look up a Q402 payment request by its req_ id. Read-only, no API key. Returns the amount, " +
    "token, chain, recipient, status (open | paid | expired | cancelled) and a shareable pay URL. " +
    "Use it to poll a request you created, or to inspect a requestId before paying it with " +
    "q402_request_pay. An unknown or expired id returns notFound:true (no throw).",
  inputSchema: {
    type: "object" as const,
    properties: {
      requestId: {
        type: "string" as const,
        pattern: "^req_[0-9a-f]{24}$",
        description: "Payment request id (req_ + 24 hex). Returned by q402_request_create; also the tail of a /pay/ URL.",
      },
    },
    required: ["requestId"],
    additionalProperties: false,
  },
};
