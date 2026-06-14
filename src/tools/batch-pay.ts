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
 * The recipient allowlist runs per recipient — every row must clear it.
 * The amount cap runs both per recipient AND on the batch total, so a
 * large sum can't be fanned across many sub-cap rows to slip the limit.
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
  detectAgenticModes,
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
import type { AvailableWallet, WalletModeRequest } from "./pay.js";
import { checkConsent } from "../consent.js";

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
  chain: z.enum(["avax", "bnb", "eth", "mantle", "injective", "monad", "scroll", "arbitrum"]),
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
        'forces the paid 10-chain key (≤20 recipients).',
    ),
  walletMode: z
    .enum(["eoa", "agentic-local", "agentic-server"])
    .optional()
    .describe(
      "Which wallet to spend from — same three modes as q402_pay:\n" +
        '  "eoa"              — user MetaMask/OKX EOA, signed locally with Q402_PRIVATE_KEY\n' +
        '  "agentic-local"    — Agent Wallet exported key (Q402_AGENTIC_PRIVATE_KEY)\n' +
        '  "agentic-server"   — server-managed Agent Wallet (Q402 holds the key; needs Q402_MULTICHAIN_API_KEY)\n' +
        "When MORE THAN ONE wallet is configured, you MUST ask the user which " +
        "to use before calling — do NOT guess. Phrase: \"You have multiple " +
        "wallets set up — batch from your EOA, or your Agent Wallet?\" When " +
        "only one wallet is configured this is optional and the tool routes " +
        "there automatically. Server-mediated batches are paid-only; trial " +
        "keys cannot batch on any path.",
    ),
  walletId: z
    .string()
    .optional()
    .describe(
      "Server-managed Agent Wallet only (walletMode=\"agentic-server\"). " +
        "Lowercased Agent Wallet address selecting which of the user's wallets " +
        "to spend from when they hold more than one. Omit to use the default. " +
        "Ignored for local-signing modes.",
    ),
  confirm: z
    .literal(true)
    .describe(
      "MUST be true. The user must have explicitly approved this exact set " +
        "of recipients, amounts, chain, and token in the conversation right " +
        "before this tool was called. Setting confirm=true on behalf of the " +
        "user without that approval is a violation of the tool contract.",
    ),
  consentToken: z
    .string()
    .optional()
    .describe(
      "Two-phase consent. LEAVE UNSET on the first call: the tool will NOT send " +
        "— it returns status=\"needs_confirmation\" with a `setupHint` preview of " +
        "every recipient + amount and a `consentToken`. Relay that preview to the " +
        "user, get an explicit yes, then re-call with the SAME args plus this " +
        "`consentToken`. The tool re-derives it from the batch it is about to send " +
        "and refuses on mismatch, so you cannot preview one batch and execute " +
        "another. Never fabricate a token.",
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
   * `needs_wallet_choice` / `wallet_mode_unavailable` are returned when the
   * user has multiple wallets configured AND no `walletMode` was passed
   * (or the passed mode lacks its env). The agent must relay
   * `ambiguousWalletChoice` to the user and retry with `walletMode` set.
   */
  status:
    | "success"
    | "partial_failure"
    | "aborted"
    | "sandbox"
    | "ambiguous"
    | "settlement_uncertain"
    | "trial_cap_exceeded"
    | "needs_wallet_choice"
    | "wallet_mode_unavailable"
    | "needs_confirmation";
  result?: BatchPayResult | { sandbox: PayResult[]; reason: string };
  guardsApplied: string[];
  setupHint?: string;
  /** Two-phase consent token to echo back on the confirming re-call. Present
   *  only with status="needs_confirmation"; nothing was sent. */
  consentToken?: string;
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
  /**
   * Set when more than one wallet mode is configured AND the caller did
   * NOT pass `walletMode`. The AI must relay `question` to the user, collect
   * the answer, and retry with the chosen `walletMode`. Mirrors q402_pay.
   */
  ambiguousWalletChoice?: {
    question: string;
    available: AvailableWallet[];
  };
}

function maxAmountGuardBatch(recipients: BatchPayInput["recipients"], cap: number): void {
  // Each row must individually clear the cap, AND the batch TOTAL must
  // clear it too. F7: the env is named PER_CALL and a batch is one call,
  // but the old code only checked each row — so an agent could fan a large
  // sum across many sub-cap rows (e.g. 20 × $200 = $4,000 under a $200 cap)
  // and slip past the exact limit the user set to bound a single decision.
  let total = 0;
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
    total += numeric;
  }
  if (total > cap) {
    throw new Error(
      `batch total $${total.toFixed(2)} across ${recipients.length} recipients exceeds the ` +
        `per-call cap of $${cap}. Q402_MAX_AMOUNT_PER_CALL bounds the WHOLE batch, not each ` +
        `row. Raise the cap if this batch is intentional, or split it into smaller batches.`,
    );
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
  guardsApplied.push(`max_amount<=${CONFIG.maxAmountPerCallUsd} (per row AND batch total)`);

  recipientAllowlistGuardBatch(input.recipients, CONFIG.allowedRecipients);
  if (CONFIG.allowedRecipients.length > 0) {
    guardsApplied.push(`recipient_allowlist[${CONFIG.allowedRecipients.length}]`);
  }

  // ── Two-phase consent (F3) ──────────────────────────────────────────────
  // confirm:true alone can't prove the human approved THIS batch — a single
  // injected call could fan funds to attacker rows. Bind a consentToken to the
  // exact recipient set: the first call (no / stale token) previews the full
  // list WITHOUT sending, and the agent must re-call with the token after a
  // human yes. The tool re-derives the token from the batch it is about to
  // send and refuses on mismatch.
  const consentIntent = {
    t: "batch",
    chain: input.chain,
    token: input.token,
    recipients: input.recipients.map((r) => ({ to: r.to.toLowerCase(), amount: r.amount })),
  };
  const consent = checkConsent(consentIntent, input.consentToken);
  if (!consent.ok) {
    const total = input.recipients.reduce((s, r) => s + Number(r.amount), 0);
    const lines = input.recipients
      .map((r, i) => `  ${i + 1}. ${r.amount} ${input.token} -> ${r.to}`)
      .join("\n");
    return {
      mode: "none",
      status: "needs_confirmation",
      guardsApplied: [...guardsApplied, "two_phase_consent"],
      consentToken: consent.expected,
      setupHint:
        `Batch on ${input.chain}: ${input.recipients.length} recipients, total ` +
        `${total} ${input.token}.\n${lines}\n` +
        `Confirm the full list with the user, then re-call q402_batch_pay with the ` +
        `same args plus consentToken="${consent.expected}".`,
    };
  }

  // ── Wallet mode disambiguation ─────────────────────────────────────────
  // Mirror q402_pay's three-mode picker: when more than one wallet is
  // configured (Mode A: real EOA, Mode B: Agent Wallet exported key,
  // Mode C: server-managed Agent Wallet) AND the caller did NOT specify
  // walletMode, return without firing so the AI can ask the user. Same
  // safety contract as single-pay — never pick silently when ambiguous.
  const modes = detectAgenticModes(CONFIG);
  const available: AvailableWallet[] = [];
  if (modes.modeA && CONFIG.privateKey && isValidPrivateKey(CONFIG.privateKey)) {
    try {
      const addr = new Wallet(CONFIG.privateKey).address;
      available.push({
        id: "eoa",
        label: "Your real MetaMask / OKX EOA",
        addressShort: `${addr.slice(0, 6)}…${addr.slice(-4)}`,
        note: "Signs locally with Q402_PRIVATE_KEY. Your wallet becomes EIP-7702-delegated after the first payment on each chain.",
      });
    } catch { /* defensive */ }
  }
  if (modes.modeB && CONFIG.agenticPrivateKey && isValidPrivateKey(CONFIG.agenticPrivateKey)) {
    try {
      const addr = new Wallet(CONFIG.agenticPrivateKey).address;
      available.push({
        id: "agentic-local",
        label: "Agent Wallet (local signing with exported key)",
        addressShort: `${addr.slice(0, 6)}…${addr.slice(-4)}`,
        note: "Signs locally with Q402_AGENTIC_PRIVATE_KEY. Your MetaMask is never touched.",
      });
    } catch { /* defensive */ }
  }
  if (modes.modeC) {
    available.push({
      id: "agentic-server",
      label: "Agent Wallet (server-managed)",
      note: "Q402 holds the encrypted key; batch fires through /api/wallet/agentic/batch. Caps you set in the dashboard bound the spend.",
    });
  }

  const requestedMode = input.walletMode;
  const requestedAvailable = requestedMode
    ? available.some((w) => w.id === requestedMode)
    : false;

  if (requestedMode && !requestedAvailable) {
    return {
      mode: "none",
      status: "wallet_mode_unavailable",
      guardsApplied: [
        ...guardsApplied,
        `wallet_modes_available=${available.length}`,
        `requested=${requestedMode}`,
      ],
      ambiguousWalletChoice: {
        question:
          available.length === 0
            ? `The "${requestedMode}" wallet isn't configured. None of the supported wallets are set up — see the doctor for setup instructions.`
            : `The "${requestedMode}" wallet isn't configured in this environment. Supported wallets here: ${available
                .map((w) => `"${w.id}"`)
                .join(", ")}. Which would you like to use instead?`,
        available,
      },
    };
  }

  if (available.length > 1 && !requestedMode) {
    return {
      mode: "none",
      status: "needs_wallet_choice",
      guardsApplied: [...guardsApplied, `wallet_modes_available=${available.length}`],
      ambiguousWalletChoice: {
        question:
          available.length === 2
            ? `You have ${available.length} wallets set up — which one should I batch-pay from?`
            : `You have ${available.length} wallets set up. Which one should I batch-pay from?`,
        available,
      },
    };
  }

  const effectiveMode: WalletModeRequest =
    requestedMode && requestedAvailable
      ? requestedMode
      : available.length === 1 && available[0]
        ? available[0].id
        : "eoa";

  // Derive sender wallet based on the effective mode. Mode C has no
  // local key — senderWallet stays undefined; the server response carries
  // the from-address in each row's relay record. For Mode A/B we echo
  // the address derived from the signing PK so the AI surfaces "batch
  // signing from 0xabc…1234 on bnb" alongside the recipient list.
  let senderWallet: BatchPaySummary["senderWallet"];
  const echoPk: string | null =
    effectiveMode === "eoa"
      ? CONFIG.privateKey
      : effectiveMode === "agentic-local"
        ? CONFIG.agenticPrivateKey
        : null;
  if (echoPk && isValidPrivateKey(echoPk)) {
    try {
      const addr = new Wallet(echoPk).address;
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
  //
  // EXCEPTION for walletMode="agentic-server": the server-mediated batch
  // endpoint (/api/wallet/agentic/batch) is paid-only — it rejects Trial
  // keys outright. If `auto` resolved to Trial here (BNB + ≤
  // RECIPIENT_LIMIT_TRIAL), Mode C would later 402 server-side and the
  // user would see "I have a paid key but my batch failed". Force
  // multichain when the user committed to Mode C — the explicit
  // user-supplied scope (`trial` / `multichain`) is still respected.
  const rawScopeRequest: KeyScopeRequest = input.keyScope ?? "auto";
  const scopeRequest: KeyScopeRequest =
    effectiveMode === "agentic-server" && rawScopeRequest === "auto"
      ? "multichain"
      : rawScopeRequest;

  // Explicit trial scope overflow — reject BEFORE the per-row signing
  // loop in client.ts. Without this guard, `keyScope="trial"` with 6+
  // recipients would sign N witness + authorization pairs locally and
  // ship the batch, only for the server to reject with TRIAL_BATCH_CAP.
  // From the user's seat that looks like "I confirmed, signed N times,
  // and got nothing" — a much worse failure mode than the auto-ambiguous
  // path below, which never signs. Surface the cap up front so the
  // agent can prompt the human to split or escalate before signing.
  if (
    scopeRequest === "trial" &&
    input.recipients.length > RECIPIENT_LIMIT_TRIAL
  ) {
    guardsApplied.push("trial_cap_exceeded");
    return {
      mode: "none",
      status: "trial_cap_exceeded",
      guardsApplied,
      senderWallet,
      setupHint:
        `keyScope="trial" caps at ${RECIPIENT_LIMIT_TRIAL} recipients per call (BNB-only sponsored). ` +
        `Your batch has ${input.recipients.length}. Either trim to the first ${RECIPIENT_LIMIT_TRIAL} ` +
        `recipients and re-invoke with keyScope="trial", or send the full batch on the paid ` +
        `Multichain key by re-invoking with keyScope="multichain" (charges the paid pool + Gas Tank, ` +
        `up to ${RECIPIENT_LIMIT_PAID} per call).`,
    };
  }

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

  // ── Mode C — server-mediated, no local signing ──────────────────────────
  // Fires before the Mode A/B live gate because Mode C doesn't need a
  // local PK at all; the server holds the Agent Wallet's key. We still
  // require a live multichain apiKey and Q402_ENABLE_REAL_PAYMENTS=1
  // (sandbox Mode C is meaningless — there's no fake server-mediated
  // path). RLUSD isn't supported on the server signer yet — surface a
  // clean explanation instead of letting the relay return INVALID_TOKEN.
  if (effectiveMode === "agentic-server") {
    if (input.token === "RLUSD") {
      return {
        mode: "none",
        status: "sandbox",
        guardsApplied: [
          ...guardsApplied,
          "wallet=agentic-server",
          "token=RLUSD",
          "rejected_pre_relay",
        ],
        senderWallet,
        setupHint:
          "RLUSD is not yet supported by the server-managed Agent Wallet " +
          "(walletMode=\"agentic-server\"). Switch to walletMode=\"eoa\" or " +
          "\"agentic-local\" (with a private key set), or pick USDC/USDT for " +
          "this batch.",
      };
    }
    if (!resolved.apiKey || !resolved.apiKey.startsWith("q402_live_")) {
      const sandboxResults = input.recipients.map((r) =>
        sandboxPay(chain, { to: r.to, amount: r.amount, token: input.token }),
      );
      guardsApplied.push("mode=sandbox", "wallet=agentic-server");
      const reason =
        resolved.sandboxReason ??
        "Server-mediated Agent Wallet needs a live Q402_MULTICHAIN_API_KEY. " +
          "Visit https://q402.quackai.ai/payment to activate a paid plan.";
      return {
        mode: "sandbox",
        status: "sandbox",
        result: { sandbox: sandboxResults, reason },
        senderWallet,
        guardsApplied,
        setupHint: reason,
      };
    }
    if (!CONFIG.realPaymentsRequested) {
      const sandboxResults = input.recipients.map((r) =>
        sandboxPay(chain, { to: r.to, amount: r.amount, token: input.token }),
      );
      guardsApplied.push("mode=sandbox", "wallet=agentic-server");
      const reason = "Set Q402_ENABLE_REAL_PAYMENTS=1 to fire a real server-mediated batch.";
      return {
        mode: "sandbox",
        status: "sandbox",
        result: { sandbox: sandboxResults, reason },
        senderWallet,
        guardsApplied,
        setupHint: reason,
      };
    }

    // Multi-wallet (Phase 3): pick by explicit walletId in the input,
    // then by Q402_AGENT_WALLET_ADDRESS env, then let the server pick
    // the user's default.
    const explicitWalletId =
      typeof input.walletId === "string" && input.walletId.length > 0
        ? input.walletId.toLowerCase()
        : CONFIG.walletId;

    let resp: Response;
    try {
      resp = await fetch(`${CONFIG.relayBaseUrl}/wallet/agentic/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: resolved.apiKey,
          chain: input.chain,
          token: input.token,
          recipients: input.recipients,
          ...(explicitWalletId ? { walletId: explicitWalletId } : {}),
        }),
      });
    } catch (e) {
      return {
        mode: "live",
        status: "aborted",
        guardsApplied: [
          ...guardsApplied,
          "wallet=agentic-server",
          "mode=live",
          "transport=fetch_failed",
        ],
        senderWallet,
        error: e instanceof Error ? e.message : String(e),
      };
    }

    const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;

    if (!resp.ok) {
      const errMsg =
        data && typeof data === "object" && "error" in data
          ? String((data as { error: unknown }).error)
          : `relay_http_${resp.status}`;
      // Relay outcome UNCERTAIN (server 502 status:"uncertain"): one or more
      // rows may have settled on-chain even though the response was lost. This
      // is NOT a clean abort — re-sending re-signs with a fresh nonce and could
      // double-pay. The server's idempotency guard already refuses to re-fire
      // THIS exact batch; the agent must verify on-chain, NOT retry.
      if ((data as { status?: string }).status === "uncertain") {
        return {
          mode: "live",
          status: "settlement_uncertain",
          guardsApplied: [
            ...guardsApplied,
            "wallet=agentic-server",
            "mode=live",
            `http=${resp.status}`,
          ],
          senderWallet,
          error: errMsg,
          setupHint:
            "The relay did not confirm whether these payments settled — they MAY have been sent. " +
            "DO NOT retry this batch; verify the recipients' on-chain balances first. Re-sending could double-pay.",
        };
      }
      return {
        mode: "live",
        status: "aborted",
        guardsApplied: [
          ...guardsApplied,
          "wallet=agentic-server",
          "mode=live",
          `http=${resp.status}`,
        ],
        senderWallet,
        error: errMsg,
        setupHint:
          resp.status === 402
            ? "Server-mediated batch requires a paid Multichain subscription. " +
              "Activate one at https://q402.quackai.ai/payment."
            : resp.status === 401
              ? "apiKey was rejected by the server (stale or not bound to your owner). " +
                "Rotate to the current key in your dashboard."
              : resp.status === 404
                ? "No active Agent Wallet found. Create one in your dashboard before retrying."
                : undefined,
      };
    }

    const serverResults = Array.isArray(data.results)
      ? (data.results as Array<{
          to?: string;
          amount?: string;
          ok?: boolean;
          txHash?: string;
          error?: string;
        }>)
      : [];
    const settled = serverResults.filter((r) => r.ok === true).length;
    const failed = serverResults.length - settled;
    // Server now sets `aborted: true` when row 0 failed (the EIP-7702
    // delegation never landed, so rows 1..N were marked
    // ABORTED_AFTER_ROW_0_FAILURE without firing). Treat that as
    // authoritative; fall back to the settled===0 inference for older
    // server versions that don't send the field yet.
    const serverAborted =
      typeof (data as { aborted?: unknown }).aborted === "boolean"
        ? ((data as { aborted: boolean }).aborted)
        : null;
    const isAborted = serverAborted ?? (settled === 0 && failed > 0);
    const status: BatchPaySummary["status"] =
      failed === 0
        ? "success"
        : isAborted
          ? "aborted"
          : "partial_failure";

    guardsApplied.push(
      "mode=live",
      "wallet=agentic-server",
      "scope=multichain (server enforced)",
      `batch_size=${serverResults.length}/${RECIPIENT_LIMIT_PAID}`,
    );
    return {
      mode: "live",
      status,
      result: {
        ok: failed === 0,
        scope: "paid",
        limit: RECIPIENT_LIMIT_PAID,
        totalSuccess: settled,
        totalFailed: failed,
        aborted: isAborted,
        results: serverResults.map((r) => ({
          success: r.ok === true,
          txHash: r.txHash,
          error: r.error,
        })),
      },
      guardsApplied,
      senderWallet,
    };
  }

  const live = isLiveModeFor(resolved);
  if (!live) {
    const sandboxResults = input.recipients.map((r) =>
      sandboxPay(chain, { to: r.to, amount: r.amount, token: input.token }),
    );
    guardsApplied.push("mode=sandbox", `wallet=${effectiveMode}`);
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

  // Pick the local signing key based on the effective wallet mode.
  // Mode C was already handled above (server-mediated). Modes A and B
  // both sign locally; pick the key matching the user's effective mode
  // rather than always preferring B, so an explicit Mode A choice isn't
  // silently routed to the Agent Wallet key.
  const signingPk: string | null =
    effectiveMode === "eoa"
      ? CONFIG.privateKey
      : effectiveMode === "agentic-local"
        ? CONFIG.agenticPrivateKey
        : null;
  if (!signingPk) {
    guardsApplied.push("mode=sandbox", `wallet=${effectiveMode}`);
    const sandboxResults = input.recipients.map((r) =>
      sandboxPay(chain, { to: r.to, amount: r.amount, token: input.token }),
    );
    const reason =
      effectiveMode === "agentic-local"
        ? "Set Q402_AGENTIC_PRIVATE_KEY to your Agent Wallet's exported private key."
        : "Set Q402_PRIVATE_KEY to your EOA private key.";
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
    privateKey: signingPk,
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
    guardsApplied.push("mode=live", `wallet=${effectiveMode}`);
    guardsApplied.push(`scope=${result.scope} (server enforced)`);
    guardsApplied.push(`batch_size=${input.recipients.length}/${result.limit}`);
    return { mode: "live", status: "success", result, guardsApplied, senderWallet };
  } catch (err) {
    if (err instanceof BatchPayError) {
      guardsApplied.push("mode=live", `wallet=${effectiveMode}`);
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
  // multichain scope → /payment (paid plan, all 10 chains).
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
    "\n\n" +
    "MULTI-WALLET DISAMBIGUATION — when more than one wallet is configured " +
    "in the user's env (Q402_PRIVATE_KEY for the real EOA, " +
    "Q402_AGENTIC_PRIVATE_KEY for the Agent Wallet's exported key, or only " +
    "Q402_MULTICHAIN_API_KEY for the server-managed Agent Wallet), the tool " +
    "RETURNS WITHOUT firing with `status='needs_wallet_choice'` and an " +
    "`ambiguousWalletChoice` payload — relay the question to the user verbatim, " +
    "then call again with the chosen `walletMode` ('eoa' | 'agentic-local' | " +
    "'agentic-server'). Do NOT pick a wallet on the user's behalf when multiple " +
    "are available. Server-mediated batches go through " +
    "/api/wallet/agentic/batch and are paid-only (the trial key cannot batch). " +
    "\n\n" +
    "ALWAYS get explicit user confirmation " +
    "of the complete recipient + amount list, chain, and token in conversation immediately " +
    "before calling this tool — the user must approve the full batch, not the individual rows. " +
    "\n\n" +
    "TWO-PHASE CONSENT: confirm:true alone does NOT send. Call this tool first WITHOUT " +
    "consentToken — it returns status=\"needs_confirmation\" with a `setupHint` preview of every " +
    "recipient + amount and a `consentToken`, and moves no money. Relay that preview to the user, " +
    "get an explicit yes, then re-call with the SAME args plus the `consentToken` to execute. The " +
    "token is re-derived from the batch about to run, so the previewed batch can't be swapped.",
  inputSchema: {
    type: "object" as const,
    properties: {
      chain: {
        type: "string",
        // Narrower than the full chain set — xlayer and stable are NOT batchable
        // (chain-specific nonce field shapes). Use q402_pay in a loop for
        // those chains.
        enum: ["avax", "bnb", "eth", "mantle", "injective", "monad", "scroll", "arbitrum"],
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
      walletMode: {
        type: "string",
        enum: ["eoa", "agentic-local", "agentic-server"],
        description:
          'Which wallet to spend from. "eoa" = user MetaMask EOA ' +
          '(Q402_PRIVATE_KEY). "agentic-local" = Agent Wallet exported key ' +
          '(Q402_AGENTIC_PRIVATE_KEY). "agentic-server" = server-managed ' +
          "Agent Wallet (Q402 holds the key; only the apiKey is needed). " +
          "When MULTIPLE wallets are configured the tool refuses without this " +
          "arg and returns ambiguousWalletChoice for the user to pick. Server-" +
          "mediated batches are paid-only.",
      },
      walletId: {
        type: "string",
        description:
          'Server-managed Agent Wallet only (walletMode="agentic-server"). ' +
          "Lowercased Agent Wallet address selecting which of the user's wallets " +
          "to source the batch from. Omit to use the default. Ignored for local-" +
          "signing modes.",
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
