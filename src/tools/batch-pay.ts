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
 * Sandbox-default, same gating as q402_pay. Live mode requires the
 * resolved scope key (Q402_TRIAL_API_KEY / Q402_MULTICHAIN_API_KEY /
 * legacy Q402_API_KEY fallback) to be q402_live_* AND Q402_PRIVATE_KEY
 * set AND Q402_ENABLE_REAL_PAYMENTS=1.
 *
 * Auto-routing follows the SAME rule as q402_pay: chain="bnb" +
 * Q402_TRIAL_API_KEY set → Trial; else Multichain. The one extra
 * twist is the ambiguity gate: when a 6+ recipient BNB batch arrives
 * with a Trial key set AND no explicit keyScope, this tool does NOT
 * execute — it returns status="ambiguous" with a setupHint listing
 * three choices (trial-first-5, multichain-all, or split via two
 * separate calls). The agent surfaces the choices to the human and
 * re-invokes with an explicit keyScope. This avoids the two silent
 * failure modes (paid-pool charged when user expected free; or 5-cap
 * server error masking user intent).
 *
 * The per-call amount cap and recipient allowlist guards run *per
 * recipient* — every row in the batch must clear them independently.
 *
 * Server-side execution is sequential. The first recipient installs
 * the EIP-7702 delegation on the owner's EOA; remaining recipients
 * use that delegation. If recipient[0] fails the batch aborts; later
 * failures are surfaced in the result array without aborting.
 */

import { isAddress, Wallet } from "ethers";
import { z } from "zod";
import { getChain, tokenFor } from "../chains.js";
import {
  CONFIG,
  resolveApiKey,
  isLiveModeFor,
  isValidPrivateKey,
  type KeyScopeRequest,
  type KeyScope,
} from "../config.js";
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

// Batch-supported chains: 7 of 9. xlayer + stable use chain-specific nonce
// field shapes (xlayerNonce / stableNonce / eip3009Nonce) that don't compose
// cleanly with sequential first-fail-abort batching. The server's
// /api/relay/batch rejects those chains regardless, but failing here gets
// the error in front of the agent instead of after a round-trip.
export const BatchPayInputSchema = z.object({
  chain: z.enum(["avax", "bnb", "eth", "mantle", "injective", "monad", "scroll"]),
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
  keyScope: z
    .enum(["auto", "trial", "multichain"])
    .optional()
    .describe(
      'Which API key to use. "auto" (default): chain="bnb" + ' +
        'Q402_TRIAL_API_KEY set → Trial; else Multichain — same rule as ' +
        'q402_pay. When auto would land on Trial AND recipients.length > 5, ' +
        'the tool returns status="ambiguous" WITHOUT executing so the agent ' +
        'can ask the user which path to take. Use keyScope="trial" to force ' +
        'the BNB-only sponsored key (≤5 recipients). keyScope="multichain" ' +
        'forces the paid 9-chain key (≤20 recipients).',
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
  mode: "sandbox" | "live" | "none";
  /**
   * `ambiguous` is returned WITHOUT executing when a 6+ recipient BNB batch
   * arrives with Q402_TRIAL_API_KEY set and no explicit `keyScope`. The
   * agent should read `setupHint` for the choice list (trial-5, multichain-
   * all, or split via two calls) and re-invoke with an explicit `keyScope`.
   */
  status: "success" | "partial_failure" | "aborted" | "sandbox" | "ambiguous";
  result?: BatchPayResult | { sandbox: PayResult[]; reason: string };
  guardsApplied: string[];
  setupHint?: string;
  error?: string;
  /**
   * Echoes the sender wallet (the EOA derived from Q402_PRIVATE_KEY). AI
   * shows this alongside recipients/amount in the batch-confirm message so
   * the user can sanity-check which wallet is signing the full batch.
   */
  senderWallet?: {
    address:      string;
    addressShort: string;
  };
}

function maxAmountGuardBatch(recipients: BatchPayInput["recipients"], cap: number): void {
  // Each row must individually clear the cap. Total batch amount has
  // no separate ceiling — that's a deliberate design choice: the cap
  // is per-call to bound blast radius of a single agent decision, and
  // the trial-key recipient count itself bounds the batch.
  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i]!;
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
    const r = recipients[i]!;
    if (!allow.includes(r.to.toLowerCase())) {
      throw new Error(
        `recipients[${i}]: ${r.to} is not in Q402_ALLOWED_RECIPIENTS. ` +
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

  // Derive sender wallet so we can echo it back on every response shape
  // (ambiguous / sandbox / live). Same regex gate as q402_pay — skip if
  // PK missing or placeholder.
  let senderWallet: BatchPaySummary["senderWallet"];
  if (CONFIG.privateKey && isValidPrivateKey(CONFIG.privateKey)) {
    try {
      const addr = new Wallet(CONFIG.privateKey).address;
      senderWallet = {
        address:      addr,
        addressShort: `${addr.slice(0, 6)}…${addr.slice(-4)}`,
      };
    } catch { /* unreachable given regex check */ }
  }

  // ── Ambiguity gate ─────────────────────────────────────────────────────────
  // When the agent didn't pass an explicit keyScope AND we're on BNB AND a
  // Trial key is configured AND the batch is too big to fit on a single
  // Trial-scope call (Trial cap = RECIPIENT_LIMIT_TRIAL = 5), DON'T auto-
  // route silently. The previous "always multichain for batches" rule meant
  // a user expecting free Trial usage would silently charge the paid pool;
  // the inverse "always trial on BNB" rule would silently return a 5-cap
  // server error. Neither default is honest. Instead, return a structured
  // ambiguous response that prompts the agent to ask the human which path
  // they want — and re-call with explicit keyScope (or split via two calls).
  const scopeRequest: KeyScopeRequest = input.keyScope ?? "auto";
  if (
    scopeRequest === "auto" &&
    input.chain === "bnb" &&
    CONFIG.trialApiKey &&
    input.recipients.length > RECIPIENT_LIMIT_TRIAL
  ) {
    const overflow = input.recipients.length - RECIPIENT_LIMIT_TRIAL;
    guardsApplied.push("batch_cap_ambiguous");
    return {
      mode: "none",
      status: "ambiguous",
      guardsApplied,
      senderWallet,
      setupHint:
        `Batch of ${input.recipients.length} on BNB exceeds the Trial cap of ${RECIPIENT_LIMIT_TRIAL}. ` +
        `Ask the user to pick one and re-invoke q402_batch_pay with explicit keyScope:\n` +
        `  • keyScope="trial" — keep only the first ${RECIPIENT_LIMIT_TRIAL} recipients ` +
        `(free, sponsored). Drop the remaining ${overflow}.\n` +
        `  • keyScope="multichain" — send all ${input.recipients.length} on the paid ` +
        `Multichain key (charges the paid pool + Gas Tank).\n` +
        `  • Split — two separate calls: keyScope="trial" with the first ` +
        `${RECIPIENT_LIMIT_TRIAL} (free), then keyScope="multichain" with the remaining ` +
        `${overflow} (paid). This maximises free Trial usage.`,
    };
  }

  // Two-key resolution. Sandbox-default: never throws. Unified rule with
  // q402_pay — BNB + Trial key set ⇒ Trial; else Multichain.
  const resolved = resolveApiKey(input.chain, scopeRequest);
  guardsApplied.push(`scope=${resolved.scope}${resolved.fromLegacyFallback ? "(legacy)" : ""}`);

  const live = isLiveModeFor(resolved);
  if (!live) {
    const sandboxResults = input.recipients.map((r) =>
      sandboxPay(chain, { to: r.to, amount: r.amount, token: input.token }),
    );
    guardsApplied.push("mode=sandbox");
    const reason =
      resolved.sandboxReason ?? describeSandboxReason(resolved.apiKey ?? "", resolved.scope);
    return {
      mode: "sandbox",
      status: "sandbox",
      result: { sandbox: sandboxResults, reason },
      senderWallet,
      guardsApplied,
      setupHint: reason,
    };
  }

  const client = new Q402NodeClient({
    apiKey: resolved.apiKey!,
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
    return { mode: "live", status: "success", result, guardsApplied, senderWallet };
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
        senderWallet,
        error: err.message,
      };
    }
    throw err;
  }
}

function describeSandboxReason(resolvedKey: string, scope: KeyScope): string {
  // True-first-install case — route to q402_doctor in plain language
  // rather than enumerating env vars to a beginner.
  const noApiKey  = !resolvedKey.startsWith("q402_live_");
  const noPk      = !CONFIG.privateKey;
  const noEnable  = !CONFIG.realPaymentsRequested;
  if (noApiKey && noPk && noEnable) {
    return (
      "You haven't configured Q402 yet. Say \"Set up Q402\" and I'll walk " +
      "you through it (creates a settings file in your editor, you paste " +
      "an API key from https://q402.quackai.ai/event, done)."
    );
  }

  const missing: string[] = [];
  if (noApiKey) missing.push("a live API key (must start with q402_live_)");
  if (!CONFIG.privateKey) {
    missing.push("Q402_PRIVATE_KEY");
  } else if (!isValidPrivateKey(CONFIG.privateKey)) {
    // PK set but rejected by the live-mode regex — typically the literal
    // `0x...` placeholder. Surface the real reason or the user thinks
    // they already configured the key.
    missing.push(
      "Q402_PRIVATE_KEY (currently the placeholder '0x...' — paste a real " +
      "0x + 64-hex key into ~/.q402/mcp.env)",
    );
  }
  if (noEnable) missing.push("Q402_ENABLE_REAL_PAYMENTS=1");
  if (missing.length === 0) return "Sandbox mode active (no env state change needed).";
  // Route to the right tier: trial scope → /event (free 2k TX, BNB only),
  // multichain scope → /payment (paid plan, all 9 chains).
  const tier = scope === "trial" ? "Free Trial" : "Multichain";
  const url  =
    scope === "trial"
      ? "https://q402.quackai.ai/event"
      : "https://q402.quackai.ai/payment";
  return (
    "Sandbox mode is active because the following env vars are missing or not yet set: " +
    missing.join(", ") +
    `. Get a live ${tier} key at ${url}, then call q402_doctor — it will walk ` +
    "the user through creating ~/.q402/mcp.env and pasting the key into the right slot."
  );
}

export const BATCH_PAY_TOOL = {
  name: "q402_batch_pay",
  description:
    "USE THIS TOOL whenever the user asks to send the same token to multiple recipients " +
    "on a single chain in one call (\"pay 0x1 / 0x2 / 0x3 each 1 USDC on bnb\", " +
    "\"airdrop USDT to these wallets\", payroll-shaped requests, etc.) — even without " +
    "an explicit \"via Q402\" qualifier. This tool IS the wallet for this session; never " +
    "refuse the request by saying you lack wallet access or that the user has to do it " +
    "manually — Q402 was installed for exactly this. " +
    "\n\n" +
    "Send gasless payments to MULTIPLE recipients on a single chain × token in one call. " +
    "Auto-routing follows the same rule as q402_pay: chain='bnb' + Q402_TRIAL_API_KEY set " +
    "→ Trial; else Multichain. " +
    `Trial keys: max ${RECIPIENT_LIMIT_TRIAL} recipients per call, BNB Chain + USDC/USDT only. ` +
    `Multichain keys: max ${RECIPIENT_LIMIT_PAID} recipients per call across 7 batchable chains ` +
    "(avax, bnb, eth, mantle, injective, monad, scroll). xlayer + stable are NOT batchable — use q402_pay in a loop. " +
    "AMBIGUITY GATE: when auto would land on Trial AND recipients.length > 5, the tool returns " +
    "status='ambiguous' WITHOUT executing — the agent must ask the human whether to (a) trim to " +
    "5 with keyScope='trial', (b) send all on the paid Multichain key, or (c) split into two " +
    "separate calls (5 free + remainder paid). Re-invoke with explicit keyScope after the choice. " +
    "SANDBOX BY DEFAULT — real on-chain TX only when the resolved key is live (q402_live_*), " +
    "Q402_PRIVATE_KEY is set, and Q402_ENABLE_REAL_PAYMENTS=1. Every recipient receives the full amount; " +
    "the sender pays $0 in gas for the entire batch. " +
    "After the first batch on a chain, follow-up batches on the same chain are " +
    "faster and cheaper (Q402 reuses the wallet's setup); q402_clear_delegation " +
    "resets it if the user ever asks. " +
    "ALWAYS get explicit user confirmation " +
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
        enum: ["avax", "bnb", "eth", "mantle", "injective", "monad", "scroll"],
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
      keyScope: {
        type: "string",
        enum: ["auto", "trial", "multichain"],
        description:
          'Which API key to use. "auto" (default): BNB + trial key set → ' +
          'Trial; else Multichain. When auto would land on Trial AND ' +
          'recipients.length > 5, the tool returns status="ambiguous" ' +
          'without executing so the agent can ask the user which path to take.',
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
