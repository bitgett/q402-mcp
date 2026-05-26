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

/** Which wallet the agent should spend from. */
export type WalletModeRequest = "eoa" | "agentic-local" | "agentic-server";

export const PayInputSchema = z.object({
  chain: z.enum(["avax", "bnb", "eth", "xlayer", "stable", "mantle", "injective", "monad", "scroll"]),
  to: z
    .string()
    .refine(isAddress, "to must be a valid 0x-prefixed EVM address")
    .describe("Recipient EVM address (0x + 40 hex)."),
  amount: z
    .string()
    .regex(/^\d+(\.\d+)?$/, "amount must be a positive decimal string")
    .describe('Human-readable decimal amount, e.g. "5.00".'),
  token: z.enum(["USDC", "USDT", "RLUSD"]).describe(
    'Stablecoin symbol. USDC / USDT supported on most chains (Injective is USDT-only). ' +
      'RLUSD (Ripple USD, NY DFS regulated, decimals 18) is Ethereum-only.',
  ),
  keyScope: z
    .enum(["auto", "trial", "multichain"])
    .optional()
    .describe(
      'Which API key to use. "auto" (default): chain="bnb" + ' +
        'Q402_TRIAL_API_KEY set → Trial (free sponsored); else Multichain. ' +
        '"trial" forces the BNB-only sponsored key. "multichain" forces ' +
        'the paid 9-chain key. Same rule applies to q402_batch_pay.',
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
  confirm: z
    .literal(true)
    .describe(
      "MUST be true. Prove the user explicitly approved this exact recipient and amount " +
        "in the conversation right before this tool was called. Setting this to true on " +
        "behalf of the user without confirmation is a violation of the tool contract.",
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
   * ticket — without it users open MetaMask, see the new badge, and panic.
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
  // Surface the chain-level token gate (Injective USDT-only) early.
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

  // Caller passed walletMode explicitly — validate that the requested mode
  // actually has the env it needs. If not, fall through to ambiguous so
  // the AI re-asks with the right phrasing.
  const requestedMode = input.walletMode;
  const requestedAvailable = requestedMode
    ? available.some((w) => w.id === requestedMode)
    : false;

  if (available.length > 1 && (!requestedMode || !requestedAvailable)) {
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
  // After the early-return above, we know either: (a) the caller asked
  // explicitly and it's available, or (b) exactly one mode is configured.
  // Falls back to "eoa" so the sandbox-setupHint branch still works when
  // nothing's configured (available.length === 0 → effective = "eoa").
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
  if (CONFIG.allowedRecipients.length > 0) {
    guardsApplied.push(`recipient_allowlist[${CONFIG.allowedRecipients.length}]`);
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

    let resp: Response;
    try {
      resp = await fetch(`${CONFIG.relayBaseUrl}/wallet/agentic/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: resolved.apiKey,
          chain: input.chain,
          token: input.token,
          to: input.to,
          amount: input.amount,
        }),
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
      | { txHash?: string; error?: string; message?: string }
      | Record<string, never>;
    const txHash = (data as { txHash?: string }).txHash ?? "";
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
  // BNB only), multichain scope → /payment (paid plan, all 9 chains).
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
    "anything else → Multichain (paid 9-chain). Same rule for q402_batch_pay. " +
    "Set keyScope='trial' or 'multichain' to force one explicitly. " +
    "Trial keys reject any non-BNB chain server-side with TRIAL_BNB_ONLY. " +
    "Multichain keys cover avax, bnb, eth, xlayer, stable, mantle, injective, monad, scroll — " +
    "USDC/USDT on most chains, RLUSD on Ethereum only, Injective USDT-only. " +
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
    "this tool.",
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
          "Stablecoin to send. USDC / USDT supported on most chains; Injective is USDT-only. " +
          "RLUSD (Ripple USD, NY DFS regulated, decimals 18) is Ethereum-only.",
      },
      keyScope: {
        type: "string",
        enum: ["auto", "trial", "multichain"],
        description:
          'Which API key to use. "auto" (default) picks Trial for BNB when ' +
          'Q402_TRIAL_API_KEY is set, Multichain otherwise. "trial" forces the ' +
          'BNB-only sponsored key. "multichain" forces the paid 9-chain key.',
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
      confirm: {
        type: "boolean",
        const: true,
        description:
          "MUST be true and only set after the user has confirmed recipient + amount in chat.",
      },
    },
    required: ["chain", "to", "amount", "token", "confirm"],
    additionalProperties: false,
  },
} as const;
