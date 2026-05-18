/**
 * q402_batch_pay — fan out a single chain × token settlement to up to
 *   - 5 recipients per call on trial-tier keys
 *   - 20 recipients per call on paid keys
 *
 * Same authorisation primitives as q402_pay: one EIP-712 witness +
 * one EIP-7702 authorization per recipient, all signed locally by
 * `Q402_PRIVATE_KEY` before the batch is shipped to the server. The
 * sender pays $0 in gas regardless of batch size — Q402's relayer
 * covers gas for every transfer.
 *
 * Sandbox-default, same gating as q402_pay (live mode requires all
 * three env vars: Q402_API_KEY live-tier + Q402_PRIVATE_KEY +
 * Q402_ENABLE_REAL_PAYMENTS=1). The per-call amount cap and recipient
 * allowlist guards run *per recipient* — every row in the batch must
 * clear them independently.
 *
 * Server-side execution is sequential. The first recipient installs
 * the EIP-7702 delegation on the owner's EOA; remaining recipients
 * use that delegation. If recipient[0] fails the batch aborts; later
 * failures are surfaced in the result array without aborting.
 */

import { isAddress } from "ethers";
import { z } from "zod";
import { getChain, tokenFor } from "../chains.js";
import { CONFIG } from "../config.js";
import {
  BatchPayError,
  Q402NodeClient,
  sandboxPay,
  type BatchPayResult,
  type PayResult,
} from "../client.js";

const RECIPIENT_LIMIT_TRIAL = 5;
const RECIPIENT_LIMIT_PAID  = 20;
// Soft client-side ceiling — paid is the larger of the two. The server
// is the authoritative gate; this just stops a malformed agent call
// from signing 100 transfers locally before we know the server will
// reject them.
const CLIENT_RECIPIENT_CAP = RECIPIENT_LIMIT_PAID;

// Batch-supported chains: 6 of 8. xlayer + stable use chain-specific nonce
// field shapes (xlayerNonce / stableNonce / eip3009Nonce) that don't compose
// cleanly with sequential first-fail-abort batching. The server's
// /api/relay/batch rejects those chains regardless, but failing here gets
// the error in front of the agent instead of after a round-trip.
export const BatchPayInputSchema = z.object({
  chain: z.enum(["avax", "bnb", "eth", "mantle", "injective", "monad"]),
  token: z.enum(["USDC", "USDT", "RLUSD"]).describe(
    "Stablecoin symbol. USDC / USDT supported on most chains (Injective is " +
      "USDT-only). RLUSD (Ripple USD, NY DFS regulated, decimals 18) is " +
      "Ethereum-only. The same token applies to every recipient in the batch.",
  ),
  recipients: z
    .array(
      z.object({
        to: z
          .string()
          .refine(isAddress, "to must be a valid 0x-prefixed EVM address")
          .describe("Recipient EVM address (0x + 40 hex)."),
        amount: z
          .string()
          .regex(/^\d+(\.\d+)?$/, "amount must be a positive decimal string")
          .describe('Human-readable decimal amount for this recipient, e.g. "5.00".'),
      }),
    )
    .min(1, "recipients must contain at least one row")
    .max(CLIENT_RECIPIENT_CAP, `recipients cannot exceed ${CLIENT_RECIPIENT_CAP} (server enforces tighter cap by key scope)`)
    .describe(
      "Array of {to, amount} pairs. All recipients share the same chain and " +
        `token. Trial keys: max ${RECIPIENT_LIMIT_TRIAL} rows. Paid keys: max ${RECIPIENT_LIMIT_PAID} rows.`,
    ),
  confirm: z
    .literal(true)
    .describe(
      "MUST be true. The user must have explicitly approved this exact set " +
        "of recipients, amounts, chain, and token in the conversation right " +
        "before this tool was called. Setting confirm=true on behalf of the " +
        "user without that approval is a violation of the tool contract.",
    ),
});

export type BatchPayInput = z.infer<typeof BatchPayInputSchema>;

export interface BatchPaySummary {
  mode: "sandbox" | "live";
  status: "success" | "partial_failure" | "aborted" | "sandbox";
  result?: BatchPayResult | { sandbox: PayResult[]; reason: string };
  guardsApplied: string[];
  setupHint?: string;
  error?: string;
}

function maxAmountGuardBatch(recipients: BatchPayInput["recipients"], cap: number): void {
  // Each row must individually clear the cap. Total batch amount has
  // no separate ceiling — that's a deliberate design choice: the cap
  // is per-call to bound blast radius of a single agent decision, and
  // the trial-key recipient count itself bounds the batch.
  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    const numeric = Number(r.amount);
    if (!Number.isFinite(numeric)) {
      throw new Error(`recipients[${i}]: unparseable amount "${r.amount}"`);
    }
    if (numeric > cap) {
      throw new Error(
        `recipients[${i}]: amount $${r.amount} exceeds the per-call cap of $${cap}. ` +
          `Set Q402_MAX_AMOUNT_PER_CALL to a higher value if intentional.`,
      );
    }
  }
}

function recipientAllowlistGuardBatch(
  recipients: BatchPayInput["recipients"],
  allow: string[],
): void {
  if (allow.length === 0) return;
  for (let i = 0; i < recipients.length; i++) {
    const to = recipients[i].to.toLowerCase();
    if (!allow.includes(to)) {
      throw new Error(
        `recipients[${i}]: ${recipients[i].to} is not in Q402_ALLOWED_RECIPIENTS. ` +
          "Either add this address to the allowlist or unset the env var to disable the guard.",
      );
    }
  }
}

export async function runBatchPay(input: BatchPayInput): Promise<BatchPaySummary> {
  const chain = getChain(input.chain);

  // Token / chain compatibility once for the whole batch (same token
  // applies to every row).
  tokenFor(chain, input.token);
  if (chain.supportedTokens && !chain.supportedTokens.includes(input.token)) {
    throw new Error(
      `token ${input.token} is not supported on chain ${chain.key}. ` +
        `Supported on this chain: ${chain.supportedTokens.join(", ")}.`,
    );
  }

  const guardsApplied: string[] = [];

  maxAmountGuardBatch(input.recipients, CONFIG.maxAmountPerCallUsd);
  guardsApplied.push(`max_amount<=${CONFIG.maxAmountPerCallUsd} (per recipient)`);

  recipientAllowlistGuardBatch(input.recipients, CONFIG.allowedRecipients);
  if (CONFIG.allowedRecipients.length > 0) {
    guardsApplied.push(`recipient_allowlist[${CONFIG.allowedRecipients.length}]`);
  }

  if (CONFIG.mode === "sandbox") {
    const sandboxResults = input.recipients.map((r) =>
      sandboxPay(chain, { to: r.to, amount: r.amount, token: input.token }),
    );
    guardsApplied.push("mode=sandbox");
    return {
      mode: "sandbox",
      status: "sandbox",
      result: { sandbox: sandboxResults, reason: describeSandboxReason() },
      guardsApplied,
      setupHint: describeSandboxReason(),
    };
  }

  const client = new Q402NodeClient({
    apiKey: CONFIG.apiKey!,
    privateKey: CONFIG.privateKey!,
    chain,
    relayBaseUrl: CONFIG.relayBaseUrl,
  });
  // We intentionally catch BatchPayError here instead of letting it bubble
  // up. Letting it throw would lose the per-row results array — the MCP
  // index.ts handler converts thrown errors into `{ error: message }` only,
  // so the agent would know "batch failed" but not "rows 0,2 landed, row 1
  // failed with insufficient gas-tank". Surfacing the structured result on
  // the BatchPaySummary lets the model report each row's fate to the user.
  try {
    const result = await client.batchPay({
      token: input.token,
      recipients: input.recipients.map((r) => ({ to: r.to, amount: r.amount })),
    });
    guardsApplied.push("mode=live");
    guardsApplied.push(`scope=${result.scope} (server enforced)`);
    guardsApplied.push(`batch_size=${input.recipients.length}/${result.limit}`);
    return { mode: "live", status: "success", result, guardsApplied };
  } catch (err) {
    if (err instanceof BatchPayError) {
      guardsApplied.push("mode=live");
      guardsApplied.push(`scope=${err.scope} (server enforced)`);
      guardsApplied.push(`batch_${err.aborted ? "aborted" : "partial_failure"}`);
      const status: BatchPaySummary["status"] = err.aborted ? "aborted" : "partial_failure";
      return {
        mode: "live",
        status,
        result: {
          ok: false,
          scope: err.scope,
          limit: err.limit,
          totalSuccess: err.totalSuccess,
          totalFailed: err.totalFailed,
          aborted: err.aborted,
          results: err.results,
        },
        guardsApplied,
        error: err.message,
      };
    }
    throw err;
  }
}

function describeSandboxReason(): string {
  const missing: string[] = [];
  if (CONFIG.apiKeyKind !== "live") missing.push("Q402_API_KEY (must start with q402_live_)");
  if (!CONFIG.privateKey) missing.push("Q402_PRIVATE_KEY");
  if (!CONFIG.realPaymentsRequested) missing.push("Q402_ENABLE_REAL_PAYMENTS=1");
  if (missing.length === 0) return "Sandbox mode active (no env state change needed).";
  return (
    "Sandbox mode is active because the following env vars are missing or not yet set: " +
    missing.join(", ") +
    ". Get a live API key at https://q402.quackai.ai/dashboard."
  );
}

export const BATCH_PAY_TOOL = {
  name: "q402_batch_pay",
  description:
    "Send gasless payments to MULTIPLE recipients on a single chain × token in one call. " +
    `Trial keys (q402_live_* with plan='trial'): max ${RECIPIENT_LIMIT_TRIAL} recipients per call, BNB Chain + ` +
    `USDC/USDT only. Paid keys: max ${RECIPIENT_LIMIT_PAID} recipients per call across 6 EIP-7702 default ` +
    "chains (avax, bnb, eth, mantle, injective, monad). xlayer + stable are NOT batchable — use q402_pay in a loop. " +
    "SANDBOX BY DEFAULT — real on-chain TX only when Q402_API_KEY (live), Q402_PRIVATE_KEY, " +
    "and Q402_ENABLE_REAL_PAYMENTS=1 are all set. Every recipient receives the full amount; " +
    "the sender pays $0 in gas for the entire batch. ALWAYS get explicit user confirmation " +
    "of the complete recipient + amount list, chain, and token in conversation immediately " +
    "before calling this tool — the user must approve the full batch, not the individual rows.",
  inputSchema: {
    type: "object" as const,
    properties: {
      chain: {
        type: "string",
        // Narrower than the full chain set — xlayer and stable are NOT batchable
        // (chain-specific nonce field shapes). Use q402_pay in a loop for
        // those chains.
        enum: ["avax", "bnb", "eth", "mantle", "injective", "monad"],
        description: "Target chain. Applies to every recipient in the batch. xlayer + stable are NOT supported here — use q402_pay in a loop.",
      },
      token: {
        type: "string",
        enum: ["USDC", "USDT", "RLUSD"],
        description:
          "Stablecoin for the entire batch. USDC / USDT supported on most chains; " +
          "Injective is USDT-only; RLUSD (decimals 18) is Ethereum-only.",
      },
      recipients: {
        type: "array",
        minItems: 1,
        maxItems: CLIENT_RECIPIENT_CAP,
        description:
          "List of recipients. Trial keys: max 5. Paid keys: max 20. " +
          "Each item is {to, amount}.",
        items: {
          type: "object",
          properties: {
            to: {
              type: "string",
              description: "Recipient EVM address (0x + 40 hex).",
            },
            amount: {
              type: "string",
              description: 'Human-readable decimal amount for this recipient, e.g. "5.00".',
            },
          },
          required: ["to", "amount"],
          additionalProperties: false,
        },
      },
      confirm: {
        type: "boolean",
        const: true,
        description:
          "MUST be true and only set after the user has confirmed the entire batch in chat.",
      },
    },
    required: ["chain", "token", "recipients", "confirm"],
    additionalProperties: false,
  },
} as const;
