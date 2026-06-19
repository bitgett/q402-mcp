/**
 * q402_pay — sandbox-default, with three layered guards before any real TX:
 *   1. Per-call max-amount (Q402_MAX_AMOUNT_PER_CALL, default $200)
 *   2. Recipient allowlist (Q402_ALLOWED_RECIPIENTS, optional)
 *   3. Live mode requires:
 *        - the resolved scope key (Q402_TRIAL_API_KEY for BNB-auto-routed
 *          calls, Q402_MULTICHAIN_API_KEY for everything else, or the legacy
 *          Q402_API_KEY single-env fallback) to be q402_live_*
 *        - Q402_PRIVATE_KEY set
 *        - Q402_ENABLE_REAL_PAYMENTS=1
 *      Any miss → sandbox response with a `setupHint` explaining which env
 *      is missing.
 *
 * The MCP tool description tells the model to ALWAYS get explicit user
 * confirmation before invoking; that is the fourth (procedural) guard.
 */

import { isAddress, Wallet } from "ethers";
import { z } from "zod";
import { CHAIN_KEYS, getChain, tokenFor } from "../chains.js";
import {
  CONFIG,
  resolveApiKey,
  isLiveModeFor,
  isValidPrivateKey,
  detectAgenticModes,
  type KeyScopeRequest,
  type KeyScope,
} from "../config.js";
import { Q402NodeClient, sandboxPay, type PayResult } from "../client.js";
import { checkConsent } from "../consent.js";

/** Which wallet the agent should spend from. */
export type WalletModeRequest = "eoa" | "agentic-local" | "agentic-server";

export const PayInputSchema = z.object({
  chain: z.enum(["avax", "bnb", "eth", "xlayer", "stable", "mantle", "injective", "monad", "scroll", "arbitrum", "base"]),
  to: z
    .string()
    .refine(isAddress, "to must be a valid 0x-prefixed EVM address")
    .describe("Recipient EVM address (0x + 40 hex)."),
  amount: z
    .string()
    .regex(/^\d+(\.\d+)?$/, "amount must be a positive decimal string")
    .describe('Human-readable decimal amount, e.g. "5.00".'),
  token: z.enum(["USDC", "USDT", "RLUSD"]).describe(
    'Stablecoin symbol. USDC / USDT supported on most chains. ' +
      'RLUSD (Ripple USD, NY DFS regulated, decimals 18) is Ethereum-only.',
  ),
  keyScope: z
    .enum(["auto", "trial", "multichain"])
    .optional()
    .describe(
      'Which API key to use. "auto" (default): chain="bnb" + ' +
        'Q402_TRIAL_API_KEY set → Trial (free sponsored); else Multichain. ' +
        '"trial" forces the BNB-only sponsored key. "multichain" forces ' +
        'the paid 11-chain key. Same rule applies to q402_batch_pay.',
    ),
  walletMode: z
    .enum(["eoa", "agentic-local", "agentic-server"])
    .optional()
    .describe(
      "Which wallet to spend from:\n" +
        '  "eoa"              — the user\'s real MetaMask/OKX EOA, signed locally with Q402_PRIVATE_KEY\n' +
        '  "agentic-local"    — the Agent Wallet\'s exported private key (Q402_AGENTIC_PRIVATE_KEY)\n' +
        '  "agentic-server"   — the server-managed Agent Wallet (Q402 holds the key; you only need Q402_MULTICHAIN_API_KEY)\n' +
        "When MORE THAN ONE wallet is configured in the user's environment, you MUST " +
        'ask the user which to use before calling — do NOT guess. Phrase: "You have ' +
        "multiple wallets set up — pay from your EOA, or your Agent Wallet?\" " +
        "When only one wallet is configured this argument is optional and the tool " +
        "routes there automatically.",
    ),
  walletId: z
    .string()
    .optional()
    .describe(
      "Server-managed Agent Wallet only (walletMode=\"agentic-server\"). Lowercased " +
        "Agent Wallet address selecting which of the user's wallets to spend from when " +
        "they hold more than one (max 10 per owner). Omit to use the user's default wallet. " +
        "Ignored for walletMode=\"eoa\" and \"agentic-local\" since those modes carry their " +
        "own signing key.",
    ),
  confirm: z
    .literal(true)
    .describe(
      "MUST be true. Prove the user explicitly approved this exact payment in the " +
        "conversation right before this tool was called. When hookParams is set you MUST " +
        "confirm what it actually does to the money: the split RECIPIENTS and their shares " +
        "(funds go to those addresses, not `to`), and any oracle condition gating the " +
        "settlement — not just the top-level recipient and amount. Setting this to true on " +
        "behalf of the user without that confirmation is a violation of the tool contract.",
    ),
  consentToken: z
    .string()
    .optional()
    .describe(
      "Two-phase consent. LEAVE THIS UNSET on the first call: the tool will NOT " +
        "send — it returns status=\"needs_confirmation\" with a human-readable " +
        "`preview` of the exact payment and a `consentToken`. Relay that preview " +
        "to the user verbatim, get their explicit yes, then call again with the " +
        "SAME args plus this `consentToken`. The tool re-derives the token from the " +
        "params it is about to execute and refuses on mismatch, so you cannot " +
        "preview one payment and execute another. Never fabricate a token.",
    ),
  hookParams: z
    .object({
      recipientAgentId: z.string().optional().describe("ReputationGate: the recipient's ERC-8004 agent id."),
      condition: z
        .object({
          kind: z.enum(["price", "timestamp"]),
          feed: z.string().optional().describe('Chainlink feed pair for kind="price", e.g. "BTC/USD".'),
          op: z.enum([">=", "<=", ">", "<", "after", "before"]),
          value: z.number().describe('USD price (kind="price") or unix seconds (kind="timestamp").'),
        })
        .optional()
        .describe('ConditionalOracle: settle only when this condition holds, e.g. { kind:"price", feed:"BTC/USD", op:">=", value:80000 }.'),
      splits: z
        .array(z.object({ recipient: z.string(), bps: z.number() }))
        .optional()
        .describe("MultiPayeeSplit: per-payment N-way split; bps must sum to 10000."),
    })
    .optional()
    .describe(
      "Q402 Hook parameters (server-managed Agent Wallet path only). Attaches per-payment " +
        "hook conditions: a ConditionalOracle price/time gate, a MultiPayeeSplit fan-out, or a " +
        "ReputationGate recipient agent id. Honoured only on walletMode=\"agentic-server\".",
    ),
});

export type PayInput = z.infer<typeof PayInputSchema>;

/** Detail for one configured wallet, surfaced when the AI must
 *  disambiguate which to spend from. */
export interface AvailableWallet {
  id: WalletModeRequest;
  label: string;
  addressShort?: string;
  note?: string;
}

export interface PaySummary {
  result: PayResult;
  guardsApplied: string[];
  setupHint?: string;
  /**
   * Two-phase consent. Set (with `result.success: false`, no on-chain tx)
   * when the call arrived without a valid `consentToken`. The AI must relay
   * `preview` to the user verbatim, get an explicit yes, then re-call with the
   * same args plus `needsConsent.consentToken`. Nothing was sent.
   */
  needsConsent?: {
    status: "needs_confirmation";
    preview: string;
    consentToken: string;
  };
  /** Set when more than one wallet mode is configured AND the caller did
   *  NOT pass `walletMode`. The AI must relay `question` to the user,
   *  collect the answer, and retry with the chosen `walletMode`. */
  ambiguousWalletChoice?: {
    question: string;
    available: AvailableWallet[];
  };
  /**
   * Echoes back the sender wallet (the EOA derived from Q402_PRIVATE_KEY)
   * so the AI surfaces "signing from 0xabc…1234 on bnb" alongside the
   * recipient / amount confirmation. Lets the user verify the wallet
   * matches what they configured before any signature is collected.
   * Always present on live calls; on sandbox calls it's still populated
   * when a PK is configured so test runs preview the same address.
   */
  senderWallet?: {
    /** Full 0x address — used for verification, NOT for display. */
    address:      string;
    /** Short masked form (`0xabc…1234`) — the AI's preferred display. */
    addressShort: string;
  };
  /**
   * Live payments only — heads-up the AI should forward to the user
   * proactively. Currently used to flag the EIP-7702 delegation side-effect
   * after the first payment on a chain ("your wallet now shows 'Smart
   * account' in MetaMask, here's why, and here's how to clear it if you
   * ever want to receive native gas tokens to that EOA"). The post-payment
   * tip is a tiny piece of context that heads off a predictable support
   * ticket — without it users open MetaMask, see the new badge, and worry.
   */
  postPaymentTip?: string;
}

function maxAmountGuard(amount: string, cap: number): void {
  // amount comes pre-validated as `\d+(\.\d+)?` — Number() is safe here for
  // a comparison against the per-call USD cap (the cap is intentionally a
  // small UI-friendly value, so float precision is irrelevant for the check).
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) {
    throw new Error(`unparseable amount "${amount}"`);
  }
  if (numeric > cap) {
    throw new Error(
      `amount $${amount} exceeds the per-call cap of $${cap}. ` +
        `Set Q402_MAX_AMOUNT_PER_CALL to a higher value if intentional.`,
    );
  }
}

function recipientGuard(to: string, allow: string[]): void {
  if (allow.length === 0) return;
  if (!allow.includes(to.toLowerCase())) {
    throw new Error(
      `recipient ${to} is not in Q402_ALLOWED_RECIPIENTS. ` +
        "Either add this address to the allowlist or unset the env var to disable the guard.",
    );
  }
}

export async function runPay(input: PayInput): Promise<PaySummary> {
  const chain = getChain(input.chain);
  // Surface the chain-level token gate (per-chain supportedTokens) early.
  tokenFor(chain, input.token);
  if (chain.supportedTokens && !chain.supportedTokens.includes(input.token)) {
    throw new Error(
      `token ${input.token} is not supported on chain ${chain.key}. ` +
        `Supported on this chain: ${chain.supportedTokens.join(", ")}.`,
    );
  }

  const guardsApplied: string[] = [];

  /** Build a PayResult shell for failure / pre-execution paths so the
   *  agent surfaces consistent fields (success, sandbox, tokenAmount,
   *  token, method, chain) even when no on-chain tx ran. */
  function failureResult(method: string): PayResult {
    return {
      success: false,
      sandbox: false,
      txHash: "",
      tokenAmount: input.amount,
      token: input.token,
      chain: chain.key,
      method,
      explorerUrl: null,
    };
  }

  // ── Wallet mode disambiguation ─────────────────────────────────────────
  // Detect which payment paths the user's env permits, then either resolve
  // to a single mode automatically or surface an `ambiguousWalletChoice`
  // payload that the AI must relay to the user before retrying. We never
  // pick silently when multiple are available — that's the whole point of
  // the prompt.
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
    } catch { /* defensive — skip */ }
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
    } catch { /* defensive — skip */ }
  }
  if (modes.modeC) {
    available.push({
      id: "agentic-server",
      label: "Agent Wallet (server-managed)",
      note: "Q402 holds the encrypted key; payment fires through /api/wallet/agentic/send. Caps you set in the dashboard bound the spend.",
    });
  }

  // Caller passed walletMode explicitly — validate that the requested
  // mode actually has the env it needs. NEVER silently substitute a
  // different wallet: the user explicitly chose "agentic-server" (or
  // "eoa", etc.) and any fallback to the wrong wallet is a misroute.
  const requestedMode = input.walletMode;
  const requestedAvailable = requestedMode
    ? available.some((w) => w.id === requestedMode)
    : false;

  // Hard-stop: requested but missing the env it needs. Don't fall
  // through to "pick the only other available wallet" — that would
  // drain a wallet the user didn't ask for. Returns the available list
  // so the AI can re-ask with the supported options.
  if (requestedMode && !requestedAvailable) {
    return {
      result: failureResult("wallet_mode_unavailable"),
      guardsApplied: [
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
      result: failureResult("needs_wallet_choice"),
      guardsApplied: [`wallet_modes_available=${available.length}`],
      ambiguousWalletChoice: {
        question:
          available.length === 2
            ? `You have ${available.length} wallets set up — which one should I pay from?`
            : `You have ${available.length} wallets set up. Which one should I pay from?`,
        available,
      },
    };
  }

  // Pick the effective wallet mode now that disambiguation passed.
  // After the early-returns above, we know either: (a) the caller
  // asked explicitly and it's available, or (b) exactly one mode is
  // configured. Falls back to "eoa" so the sandbox-setupHint branch
  // still works when nothing's configured.
  const effectiveMode: WalletModeRequest =
    requestedMode && requestedAvailable
      ? requestedMode
      : available.length === 1 && available[0]
        ? available[0].id
        : "eoa";

  // Pick the signing key for local-signing modes. Mode C doesn't sign
  // locally — the server holds the key.
  const signingPk: string | null =
    effectiveMode === "eoa"
      ? CONFIG.privateKey
      : effectiveMode === "agentic-local"
        ? CONFIG.agenticPrivateKey
        : null;

  // Derive the sender address locally so we can echo it back on every
  // response (sandbox + live). When the key is missing or malformed we
  // skip — the doctor's diagnostics already cover that path. Mode C has
  // no local key, so senderWallet stays undefined; the server-side
  // /api/wallet/agentic/send response carries the from-address instead.
  let senderWallet: PaySummary["senderWallet"];
  if (signingPk && isValidPrivateKey(signingPk)) {
    try {
      const addr = new Wallet(signingPk).address;
      senderWallet = {
        address:      addr,
        addressShort: `${addr.slice(0, 6)}…${addr.slice(-4)}`,
      };
    } catch { /* unreachable given the regex check, but defensive */ }
  }

  maxAmountGuard(input.amount, CONFIG.maxAmountPerCallUsd);
  guardsApplied.push(`max_amount<=${CONFIG.maxAmountPerCallUsd}`);

  recipientGuard(input.to, CONFIG.allowedRecipients);
  // A MultiPayeeSplit fans funds out to addresses OTHER than `to`, so the
  // allowlist must screen every split leg too — otherwise an agent could
  // route the bulk to an off-allowlist address via hookParams.splits
  // while `to` (a tiny leg) sits on the allowlist and passes the guard.
  if (input.hookParams?.splits) {
    for (const leg of input.hookParams.splits) {
      recipientGuard(leg.recipient, CONFIG.allowedRecipients);
    }
  }
  if (CONFIG.allowedRecipients.length > 0) {
    guardsApplied.push(`recipient_allowlist[${CONFIG.allowedRecipients.length}]`);
  }

  // ── Two-phase consent (F3) ──────────────────────────────────────────────
  // confirm:true is a model-filled boolean, not proof a human approved THIS
  // exact payment — a prompt-injected agent can set it and send in one covert
  // call. Require a consentToken bound to the money intent: the first call
  // (no / stale token) returns a preview and does NOT send; the agent relays
  // the preview to the user and only re-calls with the token after a yes. The
  // funding source (walletMode / walletId) IS bound into the intent below, so
  // swapping wallets after the preview correctly voids consent.
  const consentIntent = {
    t: "pay",
    chain: input.chain,
    to: input.to.toLowerCase(),
    amount: input.amount,
    token: input.token,
    // Bind the funding source too — the user is consenting to spend from THIS
    // wallet, so a different walletMode/walletId needs a fresh preview.
    wm: effectiveMode,
    wid: (input.walletId ?? "").toLowerCase(),
    ...(input.hookParams?.splits
      ? { splits: input.hookParams.splits.map((s) => ({ r: s.recipient.toLowerCase(), bps: s.bps })) }
      : {}),
    // Bind the settlement-gating hooks too — a ConditionalOracle gate or a
    // ReputationGate materially changes WHEN/IF money moves, so dropping or
    // altering them after the preview must invalidate consent.
    ...(input.hookParams?.condition
      ? { cond: { kind: input.hookParams.condition.kind, op: input.hookParams.condition.op, value: input.hookParams.condition.value, feed: input.hookParams.condition.feed ?? null } }
      : {}),
    ...(input.hookParams?.recipientAgentId
      ? { ragent: input.hookParams.recipientAgentId }
      : {}),
  };
  const consent = checkConsent(consentIntent, input.consentToken);
  if (!consent.ok) {
    const splitNote = input.hookParams?.splits
      ? ` — split ${input.hookParams.splits.length} ways; funds go to the split recipients, not ${input.to}`
      : "";
    const fromNote = senderWallet ? ` from ${senderWallet.addressShort}` : "";
    return {
      result: failureResult("consent"),
      guardsApplied: [...guardsApplied, "two_phase_consent"],
      senderWallet,
      needsConsent: {
        status: "needs_confirmation",
        preview:
          `Send ${input.amount} ${input.token} to ${input.to} on ${chain.key}${fromNote}${splitNote}. ` +
          `Confirm with the user, then re-call q402_pay with the same args plus ` +
          `consentToken="${consent.expected}".`,
        consentToken: consent.expected,
      },
    };
  }

  // Two-key resolution. Sandbox-default: never throws. When a scope can't be
  // resolved to a live key (env missing, impossible chain×scope combo, …) the
  // resolver returns `apiKey: null` plus a `sandboxReason` hint that we
  // surface as the agent-visible setupHint. Unified rule with q402_batch_pay:
  // BNB + Trial key set ⇒ Trial; else Multichain.
  const scopeRequest: KeyScopeRequest = input.keyScope ?? "auto";
  const resolved = resolveApiKey(input.chain, scopeRequest);
  guardsApplied.push(`scope=${resolved.scope}${resolved.fromLegacyFallback ? "(legacy)" : ""}`);

  // ── Mode C — server-mediated, no local signing ──────────────────────────
  // Fires before the live-mode gate because Mode C doesn't need
  // Q402_PRIVATE_KEY at all; the server holds the Agent Wallet's key. We
  // still require a live apiKey and Q402_ENABLE_REAL_PAYMENTS=1 (sandbox
  // mode C is meaningless — there's no fake server-mediated path).
  if (effectiveMode === "agentic-server") {
    // RLUSD pre-check. The server's /wallet/agentic/send currently
    // only signs USDC/USDT — the encrypted-keystore signer hasn't
    // been wired up for RLUSD yet. Without this guard the call lands
    // an opaque INVALID_TOKEN with no setup hint; surface a clean
    // explanation here instead so the AI doesn't dead-end the user.
    if (input.token === "RLUSD") {
      return {
        result: failureResult("rlusd_not_supported_for_server_mode"),
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
          "this send.",
      };
    }
    if (!resolved.apiKey || !resolved.apiKey.startsWith("q402_live_")) {
      const result = sandboxPay(chain, {
        to: input.to,
        amount: input.amount,
        token: input.token,
      });
      guardsApplied.push("mode=sandbox", "wallet=agentic-server");
      return {
        result,
        guardsApplied,
        senderWallet,
        setupHint:
          resolved.sandboxReason ??
          "Server-mediated Agent Wallet needs a live Q402_MULTICHAIN_API_KEY. " +
            "Visit https://q402.quackai.ai/payment to activate a paid plan.",
      };
    }
    if (!CONFIG.realPaymentsRequested) {
      const result = sandboxPay(chain, {
        to: input.to,
        amount: input.amount,
        token: input.token,
      });
      guardsApplied.push("mode=sandbox", "wallet=agentic-server");
      return {
        result,
        guardsApplied,
        senderWallet,
        setupHint: "Set Q402_ENABLE_REAL_PAYMENTS=1 to fire a real server-mediated payment.",
      };
    }

    // Multi-wallet (Phase 3): the user can have up to 10 Agent Wallets.
    // Pick by explicit walletId in the tool input, then by the
    // Q402_AGENT_WALLET_ADDRESS env, then let the server pick the user's default.
    const explicitWalletId =
      typeof input.walletId === "string" && input.walletId.length > 0
        ? input.walletId.toLowerCase()
        : CONFIG.walletId;

    let resp: Response;
    try {
      // 60s timeout — the route is fully synchronous (signs + relays +
      // settles + writes idempotency cache) so anything slower than
      // ~50s is almost certainly stuck. Without a timeout the MCP
      // client hangs Claude Desktop / Codex CLI indefinitely on a
      // Vercel cold-start that lost its socket. Same posture as
      // doctor / receipt / wallet-status / clear-delegation tools.
      resp = await fetch(`${CONFIG.relayBaseUrl}/wallet/agentic/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: resolved.apiKey,
          chain: input.chain,
          token: input.token,
          to: input.to,
          amount: input.amount,
          ...(explicitWalletId ? { walletId: explicitWalletId } : {}),
          // Q402 Hook params — only the Mode C (agentic-server) path runs
          // the per-wallet hook dispatch, so forwarding here is the only
          // place hookParams take effect. The landing route ignores them
          // for owner-sig calls (trust boundary), so this is safe.
          ...(input.hookParams ? { hookParams: input.hookParams } : {}),
        }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      const transportErr = failureResult("eip7702");
      return {
        result: transportErr,
        guardsApplied: [
          ...guardsApplied,
          "wallet=agentic-server",
          "mode=live",
          "transport=fetch_failed",
          `error=${e instanceof Error ? e.message : String(e)}`,
        ],
        senderWallet,
      };
    }

    const data = (await resp.json().catch(() => ({}))) as
      | {
          txHash?: string;
          error?: string;
          message?: string;
          pending?: boolean;
          status?: "processing" | "complete" | "failed" | "partial" | "relay_unreachable_uncertain";
          retryAfterSec?: number;
          idempotent?: boolean;
          sendId?: string;
          // MultiPayeeSplit fan-out shape — present on BOTH fresh splits
          // (200/207/502) and durable-replay splits (replayed:true).
          split?: boolean;
          legs?: Array<{ recipient: string; amount: string; txHash?: string; error?: string }>;
          settled?: number;
          failed?: number;
          replayed?: boolean;
        }
      | Record<string, never>;
    const txHash = (data as { txHash?: string }).txHash ?? "";

    // ── MultiPayeeSplit fan-out ──────────────────────────────────────────
    // When hookParams.splits fired, the server settles N legs instead of a
    // single recipient and returns { split:true, legs:[…], settled, failed,
    // status:'complete'|'partial'|… }. Both the FRESH split (HTTP 200/207/
    // 502) and the durable-REPLAY split (replayed:true) carry this shape, so
    // we parse them identically here — otherwise the same on-chain outcome
    // would report differently on first call vs replay.
    //
    // Pre-fix this whole branch was absent: `success = resp.ok && txHash>0`
    // reported a fully-settled split as success:false with an empty txHash
    // (the agent told the user the payment FAILED while funds had moved),
    // and a partial (HTTP 207) looked identical to a hard failure. We must
    // derive success from the split status and surface the per-leg detail.
    const isSplit =
      (data as { split?: boolean }).split === true ||
      Array.isArray((data as { legs?: unknown }).legs);
    if (isSplit) {
      const legs = Array.isArray((data as { legs?: unknown }).legs)
        ? ((data as { legs: Array<{ recipient: string; amount: string; txHash?: string; error?: string }> }).legs)
        : [];
      const status = (data as { status?: string }).status;
      const replayed = (data as { replayed?: boolean }).replayed === true;
      // settled/failed counts: trust the server's tallies when present,
      // else derive from the legs array (a leg with a txHash settled).
      const settledCount =
        typeof (data as { settled?: number }).settled === "number"
          ? (data as { settled: number }).settled
          : legs.filter((l) => typeof l.txHash === "string" && l.txHash.length > 0).length;
      const failedCount =
        typeof (data as { failed?: number }).failed === "number"
          ? (data as { failed: number }).failed
          : legs.filter((l) => !l.txHash).length;
      // complete (HTTP 200, status==='complete', all legs settled) → success.
      // partial (HTTP 207, status==='partial') → NOT a plain failure: some
      //   legs landed; surface as a distinct partial so the AI reports which
      //   legs settled and does NOT tell the user to blindly retry.
      // anything else (failed / relay_unreachable_uncertain / 0 settled) →
      //   success:false.
      const isComplete = status === "complete" && failedCount === 0;
      const isPartial = status === "partial" || resp.status === 207;
      const success = isComplete;
      const message =
        "message" in data
          ? (data as { message?: string }).message
          : "error" in data
            ? (data as { error?: string }).error
            : undefined;
      return {
        result: {
          success,
          sandbox: false,
          // Top-level txHash mirrors the server's (first settled leg). Per-leg
          // hashes in `legs` remain authoritative.
          txHash,
          tokenAmount: input.amount,
          token: input.token,
          chain: chain.key,
          method: "eip7702",
          split: true,
          legs,
          settledLegs: settledCount,
          failedLegs: failedCount,
          ...(isPartial && !isComplete ? { partial: true } : {}),
          ...(replayed ? { replayed: true } : {}),
          explorerUrl: txHash ? undefined : null,
        } satisfies PayResult,
        guardsApplied: [
          ...guardsApplied,
          "wallet=agentic-server",
          "mode=live",
          "settlement=split",
          `split_settled=${settledCount}`,
          `split_failed=${failedCount}`,
          `split_status=${status ?? "unknown"}`,
          ...(replayed ? ["replayed=true"] : []),
          ...(message ? [`server_message=${message}`] : []),
        ],
        senderWallet,
        ...(isPartial && !isComplete
          ? {
              setupHint:
                `Split PARTIALLY settled: ${settledCount} leg(s) landed on-chain, ` +
                `${failedCount} did NOT. The settled legs already moved funds — do NOT ` +
                `blindly retry the whole payment (a retry replays only the unsettled ` +
                `intent, it will not double-pay the settled legs). Inspect legs[] for ` +
                `which recipients received funds and which still need handling.`,
            }
          : {}),
      };
    }

    // Server returns HTTP 202 + `pending: true` when a concurrent
    // identical request beats us to the SET NX claim — the relay
    // hasn't settled yet, but it isn't a failure either. Without
    // this branch, `resp.ok && txHash.length > 0` reports
    // `success: false` for a perfectly normal "still in flight"
    // state. Distinguish so the AI tells the user "wait + retry"
    // instead of "your payment failed".
    const isPending =
      resp.status === 202 ||
      (data as { pending?: boolean }).pending === true ||
      (data as { status?: string }).status === "processing";
    if (isPending) {
      const retryAfter =
        typeof (data as { retryAfterSec?: number }).retryAfterSec === "number"
          ? (data as { retryAfterSec: number }).retryAfterSec
          : 5;
      return {
        result: {
          success: false,
          sandbox: false,
          txHash: "",
          tokenAmount: input.amount,
          token: input.token,
          chain: chain.key,
          method: "eip7702",
          pending: true,
          retryAfterSec: retryAfter,
        } satisfies PayResult,
        guardsApplied: [
          ...guardsApplied,
          "wallet=agentic-server",
          "mode=live",
          "status=pending",
          `retry_after=${retryAfter}s`,
        ],
        senderWallet,
        setupHint:
          "An identical send for this wallet is still in flight on the server. " +
          `Wait ${retryAfter}s and retry — the cached result will come back, no double-spend.`,
      };
    }

    const success = resp.ok && txHash.length > 0;
    const message =
      "message" in data
        ? (data as { message?: string }).message
        : "error" in data
          ? (data as { error?: string }).error
          : undefined;
    return {
      result: {
        success,
        sandbox: false,
        txHash,
        tokenAmount: input.amount,
        token: input.token,
        chain: chain.key,
        method: "eip7702",
        explorerUrl: txHash ? undefined : null,
      } satisfies PayResult,
      guardsApplied: [
        ...guardsApplied,
        "wallet=agentic-server",
        "mode=live",
        ...(message ? [`server_message=${message}`] : []),
      ],
      senderWallet,
    };
  }

  const live = isLiveModeFor(resolved);
  if (!live) {
    const result = sandboxPay(chain, {
      to: input.to,
      amount: input.amount,
      token: input.token,
    });
    guardsApplied.push("mode=sandbox", `wallet=${effectiveMode}`);
    // Prefer the resolver's specific reason (e.g. "trial+monad impossible")
    // over the generic missing-env message. Falls back to the generic when
    // the resolver returned a key but live mode failed on its own gates.
    const setupHint =
      resolved.sandboxReason ?? describeSandboxReason(resolved.apiKey ?? "", resolved.scope);
    return { result, guardsApplied, setupHint, senderWallet };
  }

  // Modes A and B both sign locally and call /api/relay — the only
  // difference is which private key the relay client uses.
  if (!signingPk) {
    // Defensive — isLiveModeFor() already gates on the EOA-mode PK; this
    // is the agentic-local branch's safety net if its env was malformed.
    return {
      result: failureResult("missing_signing_key"),
      guardsApplied: [...guardsApplied, `wallet=${effectiveMode}`, "mode=sandbox"],
      senderWallet,
      setupHint:
        effectiveMode === "agentic-local"
          ? "Set Q402_AGENTIC_PRIVATE_KEY to your Agent Wallet's exported private key."
          : "Set Q402_PRIVATE_KEY to your EOA private key.",
    };
  }
  const client = new Q402NodeClient({
    apiKey: resolved.apiKey!,
    privateKey: signingPk,
    chain,
    relayBaseUrl: CONFIG.relayBaseUrl,
  });
  const result = await client.pay({
    to: input.to,
    amount: input.amount,
    token: input.token,
  });
  guardsApplied.push("mode=live", `wallet=${effectiveMode}`);
  // Always surface the post-payment tip on successful live payments. The AI
  // can decide whether to display it (typically: yes on the first payment,
  // optional thereafter) — we always include it so the AI has the context
  // without us needing to track per-chain "did the user already see this".
  return {
    result,
    guardsApplied,
    senderWallet,
    postPaymentTip: result.success
      ? "After this payment your EOA is EIP-7702-delegated to Q402's impl on " +
        `${chain.name} — MetaMask / OKX will show it as a 'Smart account'. ` +
        "That's normal and reversible: q402_clear_delegation removes the " +
        `delegation on a specific chain (Q402 sponsors the gas, so you pay $0). ` +
        "If you ever try to receive native gas tokens directly to this EOA " +
        "and the transfer reverts, the delegation is the cause — clear it for " +
        "that chain first."
      : undefined,
  };
}

function describeSandboxReason(resolvedKey: string, scope: KeyScope): string {
  // "True first install" — user hasn't configured ANYTHING yet, just
  // installed the MCP and immediately asked for a payment. The env-var
  // jargon below is meaningless to them. Route them to q402_doctor
  // (which uses plain language + handles file creation) and skip the
  // detailed enumeration.
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
    // PK is set but doesn't pass the live-mode regex — typically the
    // literal `0x...` placeholder from the template. Surface the real
    // reason instead of generic "PK missing", or the user thinks they
    // already configured it.
    missing.push(
      "Q402_PRIVATE_KEY (currently the placeholder '0x...' — paste a real " +
      "0x + 64-hex key into ~/.q402/mcp.env)",
    );
  }
  if (noEnable) missing.push("Q402_ENABLE_REAL_PAYMENTS=1");
  if (missing.length === 0) return "Sandbox mode active (no env state change needed).";
  // Route the user to the right tier: trial scope → /event (free 2k TX,
  // BNB only), multichain scope → /payment (paid plan, all 11 chains).
  // Earlier copy always pointed at /dashboard which under-served Trial
  // users by sending them toward the paid funnel.
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

export const PAY_TOOL = {
  name: "q402_pay",
  description:
    "USE THIS TOOL whenever the user asks to send, transfer, or pay USDC / USDT / " +
    "RLUSD — even when they don't mention Q402 by name (\"send 5 USDT to 0x... on bnb\" " +
    "should route here automatically). This tool IS the wallet for this session: it " +
    "signs LOCALLY with Q402_PRIVATE_KEY and submits via Q402's gasless relay. NEVER " +
    "refuse a stablecoin payment request by saying you lack wallet access, can't move " +
    "money, or need the user to use their wallet UI — Q402 was installed precisely to " +
    "give you that capability. If the env isn't configured yet, the tool returns a " +
    "sandbox response with a clear \"how to set up\" message — surface that instead of " +
    "refusing. " +
    "\n\n" +
    "Auto-routing: chain='bnb' + Q402_TRIAL_API_KEY set → Trial (free sponsored); " +
    "anything else → Multichain (paid 11-chain). Same rule for q402_batch_pay. " +
    "Set keyScope='trial' or 'multichain' to force one explicitly. " +
    "Trial keys reject any non-BNB chain server-side with TRIAL_BNB_ONLY. " +
    "Multichain keys cover avax, bnb, eth, xlayer, stable, mantle, injective, monad, scroll, arbitrum, base — " +
    "USDC/USDT on most chains, RLUSD on Ethereum only. " +
    "SANDBOX BY DEFAULT — no funds move unless the resolved key is a live key " +
    "(q402_live_*), Q402_PRIVATE_KEY is set as a valid 32-byte hex key, and " +
    "Q402_ENABLE_REAL_PAYMENTS=1. Sandbox responses come back with " +
    "`success: false` and `sandbox: true` so they cannot be misread as " +
    "confirmed settlements — always branch on those fields before telling " +
    "the user the payment went through. " +
    "The recipient receives the full amount; the sender pays $0 in gas. " +
    "\n\n" +
    "SENDER ECHO — when a valid `Q402_PRIVATE_KEY` is configured, the response " +
    "includes a `senderWallet` field with the address derived from that key. " +
    "Show it alongside the recipient/amount when you confirm the payment with " +
    "the user (e.g. 'Signing from 0xabc…1234 on bnb → send 5 USDT to 0xdef…ABCD'). " +
    "Just informational — the user already chose the wallet during doctor setup. " +
    "Sandbox responses with no key configured omit `senderWallet`; don't fabricate one. " +
    "\n\n" +
    "MULTI-WALLET DISAMBIGUATION — when more than one wallet is configured " +
    "in the user's env (Q402_PRIVATE_KEY for the real EOA, " +
    "Q402_AGENTIC_PRIVATE_KEY for the Agent Wallet's exported key, or only " +
    "Q402_MULTICHAIN_API_KEY for the server-managed Agent Wallet), the tool " +
    "RETURNS without sending with a `ambiguousWalletChoice` payload — relay " +
    "the question to the user verbatim, then call again with the chosen " +
    "`walletMode` ('eoa' | 'agentic-local' | 'agentic-server'). Do NOT pick " +
    "a wallet on the user's behalf when multiple are available. " +
    "\n\n" +
    "EIP-7702 SIDE EFFECT — surface this to the user proactively after the " +
    "FIRST live payment on a chain: their wallet now shows up as a 'Smart " +
    "account' in MetaMask / OKX. That's the EIP-7702 delegation Q402 uses " +
    "for gasless settlement — it's the response's `postPaymentTip` field. " +
    "Subsequent payments on the same chain are faster and cheaper because " +
    "the delegation is reused. " +
    "Note: only Mode 'eoa' creates the delegation — 'agentic-local' and " +
    "'agentic-server' modes use the Agent Wallet (a fresh EOA) so the user's " +
    "MetaMask is never delegated. " +
    "\n\n" +
    "If the user EVER reports that native gas tokens (BNB / ETH / AVAX / " +
    "etc.) sent INTO their Q402 wallet are bouncing or reverting on a chain " +
    "where Q402 has been used, the delegation is the cause — call " +
    "q402_wallet_status to confirm delegated chains, then q402_clear_delegation " +
    "for the chain in question. Q402 sponsors the gas for the clear, so the " +
    "user pays $0. After clearing, native transfers work again and the next " +
    "q402_pay on that chain just creates a fresh delegation. " +
    "\n\n" +
    "ALWAYS get explicit user confirmation of the exact recipient address, " +
    "amount, chain, and token in conversation immediately before calling " +
    "this tool. " +
    "\n\n" +
    "TWO-PHASE CONSENT: confirm:true alone does NOT send. Call this tool first " +
    "WITHOUT consentToken — it returns status=\"needs_confirmation\" with a " +
    "`preview` of the exact payment and a `consentToken`, and moves no money. " +
    "Relay that preview to the user, get their explicit yes, then re-call with " +
    "the SAME args plus that `consentToken` to execute. The token is re-derived " +
    "from the params about to run, so a previewed payment can't be swapped for " +
    "a different one.",
  inputSchema: {
    type: "object" as const,
    properties: {
      chain: {
        type: "string",
        enum: CHAIN_KEYS as readonly string[],
        description: "Target chain.",
      },
      to: {
        type: "string",
        description: "Recipient EVM address (0x + 40 hex).",
      },
      amount: {
        type: "string",
        description: 'Human-readable decimal amount, e.g. "5.00".',
      },
      token: {
        type: "string",
        enum: ["USDC", "USDT", "RLUSD"],
        description:
          "Stablecoin to send. USDC / USDT supported on most chains. " +
          "RLUSD (Ripple USD, NY DFS regulated, decimals 18) is Ethereum-only.",
      },
      keyScope: {
        type: "string",
        enum: ["auto", "trial", "multichain"],
        description:
          'Which API key to use. "auto" (default) picks Trial for BNB when ' +
          'Q402_TRIAL_API_KEY is set, Multichain otherwise. "trial" forces the ' +
          'BNB-only sponsored key. "multichain" forces the paid 11-chain key.',
      },
      walletMode: {
        type: "string",
        enum: ["eoa", "agentic-local", "agentic-server"],
        description:
          'Which wallet to spend from. "eoa" = user\'s real MetaMask EOA ' +
          '(Q402_PRIVATE_KEY). "agentic-local" = Agent Wallet exported key ' +
          '(Q402_AGENTIC_PRIVATE_KEY). "agentic-server" = server-managed ' +
          "Agent Wallet (Q402 holds the key; only the apiKey is needed). " +
          "When MULTIPLE wallets are configured the tool refuses without this " +
          "arg and returns ambiguousWalletChoice for the user to pick.",
      },
      walletId: {
        type: "string",
        description:
          'Server-managed Agent Wallet only (walletMode="agentic-server"). ' +
          "Lowercased Agent Wallet address selecting which of the user's wallets " +
          "to spend from when they hold more than one (max 10 per owner). Omit " +
          "to use the user's default wallet. Ignored for the other walletMode " +
          "values since those modes carry their own signing key.",
      },
      confirm: {
        type: "boolean",
        const: true,
        description:
          "MUST be true and only set after the user has confirmed this exact payment in chat. " +
          "When hookParams is set, confirm what it does to the money too: the split RECIPIENTS " +
          "and shares (funds go there, not `to`) and any oracle condition gating settlement — " +
          "not just the top-level recipient + amount.",
      },
      consentToken: {
        type: "string",
        description:
          "Two-phase consent. Omit on the FIRST call to get a needs_confirmation preview " +
          "plus a consentToken (no funds move); re-call with the SAME args plus this token " +
          "to execute. Re-derived from the payment params, so a previewed payment cannot be " +
          "swapped for a different one. confirm:true alone does NOT send.",
      },
      hookParams: {
        type: "object",
        description:
          "Q402 Hook params (server-managed Agent Wallet only). recipientAgentId (ReputationGate), " +
          "condition (ConditionalOracle price/time gate), or splits (MultiPayeeSplit fan-out, bps sum 10000).",
        properties: {
          recipientAgentId: { type: "string" },
          condition: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["price", "timestamp"] },
              feed: { type: "string" },
              op: { type: "string", enum: [">=", "<=", ">", "<", "after", "before"] },
              value: { type: "number" },
            },
            required: ["kind", "op", "value"],
          },
          splits: {
            type: "array",
            items: {
              type: "object",
              properties: { recipient: { type: "string" }, bps: { type: "number" } },
              required: ["recipient", "bps"],
            },
          },
        },
      },
    },
    required: ["chain", "to", "amount", "token", "confirm"],
    additionalProperties: false,
  },
} as const;
