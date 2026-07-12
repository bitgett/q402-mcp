/**
 * q402_doctor - read-only, no API key required.
 *
 * Single tool covering BOTH first-install onboarding ("what do I need to set
 * up?") AND ongoing operational diagnostics ("why isn't my payment going
 * through?"). The AI calls this whenever the user says things like
 *   • "Set up Q402"
 * 　 • "Verify Q402"
 *   • "Why isn't Q402 working"
 *   • "Q402 status"
 *
 * Three phases (auto-detected from env state):
 *   1. first-install - no Q402_* envs set. Tool returns a recommendedActions
 *      payload telling the client to write a placeholder ~/.q402/mcp.env file
 *      it can open in the user's editor. Tool DOES NOT write the file itself
 *      - the MCP server has no filesystem access on the user's machine; the
 *      client (Claude Code / Codex CLI / Cursor / Cline) does.
 *   2. needs-completion - some envs set, some missing. Tool returns a
 *      structured list of what's missing + why each one matters.
 *   3. live-check - env complete enough to attempt live. Tool calls
 *      `/keys/verify` and `/wallet/delegation-status` to confirm the API key
 *      is valid, fetch quota, and report per-chain EIP-7702 delegation
 *      state.
 *
 * Security policy carried in the response:
 *   "Q402 never asks you to paste your private key into chat. Custody depends
 *   on wallet mode: Mode A (Q402_PRIVATE_KEY) and Mode B
 *   (Q402_AGENTIC_PRIVATE_KEY) sign LOCALLY - those keys never leave the
 *   user's device. Mode C (Q402_MULTICHAIN_API_KEY only) is server-managed:
 *   Q402 holds the Agent Wallet's encrypted PK and signs on the user's
 *   behalf."
 *
 * The tool description tells the AI to surface this notice whenever
 * walking a user through setup, AND to never refuse a key that's already
 * been pasted in chat (the exposure already happened - write to file +
 * warn about rotation, don't lecture).
 */

import { z }              from "zod";
import { Wallet }         from "ethers";
import {
  CONFIG,
  ENV,
  Q402_ENV_FILE_PATH,
  Q402_ENV_FILE_PRESENT,
  Q402_ENV_FILE_KEYS,
  Q402_ENV_FILE_KEYS_ALL,
  isValidPrivateKey,
  classifyApiKey,
  detectAgenticModes,
  getQ402EnvFileReadError,
} from "../config.js";
import { CHAIN_KEYS }     from "../chains.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../version.js";

export const DoctorInputSchema = z.object({});
export type  DoctorInput = z.infer<typeof DoctorInputSchema>;

type Phase = "first-install" | "needs-completion" | "live-check";

interface EnvSlot {
  /** Whether the value is present in the resolved env (file OR process). */
  set: boolean;
  /** Source of the value - file ~/.q402/mcp.env, process env, or unset. */
  source: "file" | "process" | "unset";
  /** Plain-English description of what the env var is for. */
  purpose: string;
}

interface KeyVerifyResult {
  scope:           "trial" | "multichain" | "legacy";
  envVar:          string;
  apiKeyMasked:    string;
  valid:           boolean;
  plan?:           string;
  remainingCredits?: number;
  isTrial?:        boolean;
  trialExpiresAt?: string;
  trialDaysLeft?:  number;
  /** Detected tier MISMATCH with env-var slot (e.g. Trial key in Multichain). */
  slotWarning?:    string;
  error?:          string;
}

interface DelegationState {
  chain:     string;
  delegated: boolean;
  impl?:     string;
  error?:    string;
}

type RecommendedActionType = "shell" | "write_file";

interface RecommendedAction {
  id:           string;
  type:         RecommendedActionType;
  /** For "shell": the command to run. For "write_file": the destination path. */
  path?:        string;
  shell?:       string;
  /** Cross-platform shell variants - AI picks one matching the host OS.
   *  When omitted, `shell` is assumed POSIX-compatible. */
  shellWindows?: string;
  /** For "write_file" - body to write. */
  content?:     string;
  /** Whether to ask the user before executing this action. */
  requiresUserConfirm: boolean;
  /** Short label the AI uses when offering the action. */
  description:  string;
  /** For "write_file" only: what to do when the file already exists. */
  ifExists?:    "skip" | "ask-before-overwrite";
}

export interface DoctorReport {
  /** Tool identity - handy for the AI to confirm it's looking at fresh output. */
  package: string;
  version: string;

  /** Computed phase. AI uses this to pick its tone (welcoming vs verifying). */
  phase: Phase;
  /** True only when the server can attempt real on-chain payments right now. */
  ready: boolean;

  /** Env file diagnostic - what we expect at ~/.q402/mcp.env. */
  envFile: {
    path:    string;
    exists:  boolean;
    /** Non-fatal warning (e.g. world-readable perms) - surfaced to user. */
    warning?: string;
  };

  /** Per-env-var slot state. Trial + Multichain are the canonical two - the
   *  legacy single-env fallback (`Q402_API_KEY`) is intentionally NOT
   *  surfaced here. The two-key model is the only one users should reason
   *  about; the fallback exists in config.ts to keep older integrations
   *  working without forcing a flag-day migration, and the doctor stays
   *  silent about it so first-install mental models stay clean. */
  envState: Record<string, EnvSlot>;

  /** Human-readable list of what's still required for live mode. */
  missing: string[];

  /** Live-check phase only - derived wallet address from Q402_PRIVATE_KEY. */
  wallet?: { address: string };

  /** Live-check phase only - per-scope key verification + quota. */
  keys?: KeyVerifyResult[];

  /** Live-check phase only - per-chain EIP-7702 delegation snapshot.
   *  `undefined` when wallet derivation failed (Q402_PRIVATE_KEY malformed);
   *  empty array would falsely read as "all 12 chains undelegated". */
  delegation?: DelegationState[] | undefined;

  /** Live-check phase only - relay reachability + latency. */
  relay?: { url: string; reachable: boolean; latencyMs?: number; error?: string };

  /** Free-form warnings the AI should surface (slot mismatch, quota low, etc.). */
  warnings: string[];

  /** Structured actions the client can execute on the user's filesystem. */
  recommendedActions: RecommendedAction[];

  /** Multi-turn conversation framing - what the AI should say next.
   *  Kept for back-compat with clients that read `nextStep` directly,
   *  but new code should branch on the structured
   *  `agentInstructions` / `userInstructions` pair below. */
  greeting:  string;
  nextStep:  string;

  /** Detailed prescription for the AI itself - the multi-turn flow,
   *  recommendedActions ordering, what to ask the user, what NOT to
   *  echo. This is internal tooling-prose; the AI should consult it
   *  but NOT show it verbatim to the user. (The 0.5.10 doctor's
   *  nextStep field mixed both audiences in one paragraph; clients
   *  that surface raw output showed users "execute the write_file
   *  action via the client's filesystem tool" which is meaningless
   *  noise for a non-developer.) */
  agentInstructions: string;

  /** Plain-language steps the AI CAN show the user verbatim. Three or
   *  four bullets, no `recommendedActions[]` jargon, no env-var
   *  vocabulary unless the user has already asked about it. AI clients
   *  with a UI surface should render this as an ordered list. */
  userInstructions: string[];

  /** Canonical security notice - AI MUST forward this when walking through setup. */
  securityNotice: string;

  /** First-install advisories - fresh-wallet reminder, EIP-7702 "Smart account"
   *  heads-up, hardware-wallet caveat, MetaMask private-key export breadcrumb.
   *  Populated only on the `first-install` phase. */
  advisories?: string[];

  /** Wallet-mode picker - shown on first-install / needs-completion so the
   *  AI can ask the user "which mode?" without forcing them to read docs. */
  walletModePicker?: {
    question:        string;
    helpText:        string;
    recommendedPick: "A" | "B" | "C";
    options: Array<{
      pick:               "A" | "B" | "C";
      title:              string;
      description:        string;
      env:                string[];
      privateKeyRequired: boolean;
    }>;
  };

  /** Mode summary - surfaced on live-check so the AI can answer "what
   *  mode am I in / do I need a private key?" without re-deriving the
   *  state from envState. */
  walletModes?: {
    available: Array<{ mode: "A" | "B" | "C"; label: string; rationale: string }>;
    count:     number;
    primary:   "A" | "B" | "C" | null;
    recommendation: string;
    catalog: Array<{
      mode:     "A" | "B" | "C";
      label:    string;
      envVar:   string;
      needsPk:  boolean;
      bestFor:  string;
    }>;
  };
}

// -- Env file template ------------------------------------------------------
// Secret-bearing lines (API key + PRIVATE_KEY) are commented out so
// saving + restarting the file as-is can't trip live mode by accident.
// Q402_ENABLE_REAL_PAYMENTS=1 IS the default, however - this is safe
// because the live-mode gate (config.ts:isLiveModeFor) requires BOTH:
//
//   (a) the resolved API key starts with "q402_live_"
//   (b) PRIVATE_KEY_RE matches Q402_PRIVATE_KEY (0x + exactly 64 hex)
//
// With the secret lines commented, neither is set → mode = sandbox
// regardless of the flag. With placeholders ("q402_live_..." /
// "0x..."), the API key passes the prefix check BUT the PK regex
// rejects "0x..." → still sandbox, with a clear "PK malformed" hint.
//
// Workflow becomes: uncomment ONE api-key line + paste real value,
// uncomment Q402_PRIVATE_KEY + paste real value, save, restart. Two
// edits - when both are real, you're live. Earlier versions of this
// template required a third edit (flip the flag from 0 to 1), but
// users who'd finished the API key + PK paste kept getting stuck in
// sandbox without realising the flag was still 0. The PK regex
// makes that extra friction unnecessary.
const ENV_FILE_TEMPLATE = `# ----------------------------------------------------------------------
# Q402 MCP - secrets
# ----------------------------------------------------------------------
# Read automatically by @quackai/q402-mcp on startup.
# Edit this file in your editor. NEVER paste your private key into chat.
# After editing, restart your MCP client (Codex / Claude / Cursor / Cline).
#
# SAFE-BY-DEFAULT: the api-key + private-key lines below ship EMPTY.
# Q402_ENABLE_REAL_PAYMENTS defaults to 1, but the live-mode gate also
# requires (a) a real \`q402_live_*\` API key and (b) a valid 32-byte
# hex private key. Empty values fail both checks, so saving this file
# as-is just leaves you in sandbox. Paste real values to go live.


# ----------------------------------------------------------------------
# API KEY - paste on the right of \`=\` (one OR both for auto-routing)
# ----------------------------------------------------------------------
# Free Trial:        BNB Chain only, 2,000 sponsored TX
# Get one at:        https://q402.quackai.ai/event
Q402_TRIAL_API_KEY=

# Paid Multichain:   all 12 chains, per-chain Gas Tank
# Get one at:        https://q402.quackai.ai/payment
Q402_MULTICHAIN_API_KEY=


# ----------------------------------------------------------------------
# SIGNING MODE - pick ONE of A / B / C below
# ----------------------------------------------------------------------
# Q402 pays in three ways, depending on which keys you set. Pick the
# row that matches your situation and fill ONLY that row's variable(s).
# Setting multiple rows is allowed - q402_pay will ask you which one to
# use per call (the AI surfaces the question; you don't pre-pick a
# default here).
#
#   A. Real EOA (your MetaMask wallet)
#      Set:  Q402_PRIVATE_KEY  =  0x... (your MetaMask account's private key)
#      Pros: simplest mental model - same wallet you already use
#      Cons: after first payment, MetaMask will show this account as
#            "Smart account" (EIP-7702 delegation, reversible via
#            q402_clear_delegation - the visual change can be surprising
#            the first time you see it)
#
#   B. Agent Wallet - local signing (recommended for AI agents)
#      Set:  Q402_AGENTIC_PRIVATE_KEY  =  0x... (Agent Wallet pk from dashboard export)
#      Pros: your MetaMask stays untouched; agent has its own purse with
#            per-tx + daily caps you set on the dashboard
#      Cons: requires creating an Agent Wallet on the dashboard first
#            (https://q402.quackai.ai/dashboard → Agent tab → Create)
#            then exporting its private key
#
#   C. Agent Wallet - server-managed (no private key on your machine)
#      Set:  (just the api key + optionally Q402_AGENT_WALLET_ADDRESS below)
#      Pros: zero private-key handling locally; the server holds the
#            encrypted Agent Wallet pk and signs on your behalf
#      Cons: requires a paid Multichain API key (Mode C is not available
#            on the free Trial). The server-side keystore is AES-256-GCM
#            encrypted but is a custodial path - pick A or B if that
#            posture doesn't fit your threat model.
#
# A user can have multiple wallets configured simultaneously (e.g. PK
# for personal pays + apiKey-only for agent pays). When more than one
# mode is set, q402_pay asks the user which to use rather than picking
# silently.


# ----------------------------------------------------------------------
# WALLET - Mode A: real EOA private key
# ----------------------------------------------------------------------
# Hex EVM private key (0x + 64 hex chars). Signs payments LOCALLY on
# your machine - never leaves your device, never sent to any server.
# Leave blank if you're using Mode B or Mode C.
Q402_PRIVATE_KEY=


# ----------------------------------------------------------------------
# WALLET - Mode B: exported Agent Wallet private key
# ----------------------------------------------------------------------
# Hex EVM private key (0x + 64 hex chars) exported from your Agent
# Wallet on the dashboard. Signs payments LOCALLY just like Mode A,
# but the wallet is your dedicated Agent Wallet - your MetaMask EOA
# is never touched. Get the key at:
#   https://q402.quackai.ai/dashboard → Agent tab → Export
# Leave blank if you're using Mode A or Mode C.
Q402_AGENTIC_PRIVATE_KEY=


# ----------------------------------------------------------------------
# WALLET - Mode C: server-managed Agent Wallet picker (optional)
# ----------------------------------------------------------------------
# Only set this when you're running Mode C (api key only, no private
# keys above) AND you have more than one Agent Wallet on the account
# (max 10). Pin which one Q402 should spend from. Format: lowercase
# 0x... address of the Agent Wallet (visible on the dashboard's Agent
# tab). Omit entirely to use your default Agent Wallet.
# Q402_AGENT_WALLET_ADDRESS=0x...


# ----------------------------------------------------------------------
# Live mode switch (safe even at 1 - see SAFE-BY-DEFAULT note at top)
# ----------------------------------------------------------------------
# 0 = sandbox (test mode, no funds move - every q402_pay returns a fake hash)
# 1 = real on-chain payments
# Default 1; flips to live only when the API key + private key above are
# both populated. Set to 0 to force sandbox even with real keys in place
# (e.g. for chained testing on a paid plan).
Q402_ENABLE_REAL_PAYMENTS=1


# ----------------------------------------------------------------------
# Q402 relay endpoint
# ----------------------------------------------------------------------
# Default canonical Q402 deployment. Only change for self-hosted.
Q402_RELAY_BASE_URL=https://q402.quackai.ai/api


# ----------------------------------------------------------------------
# Safety guards
# ----------------------------------------------------------------------
# Max USD per single q402_pay call. Any request above this is rejected
# before signing. Lower this if you want a tighter agent blast-radius.
Q402_MAX_AMOUNT_PER_CALL=200

# Comma-separated lowercase recipient allowlist (unset = any address OK)
# Q402_ALLOWED_RECIPIENTS=0xabc...,0xdef...
`;

const SECURITY_NOTICE =
  "Q402 never asks you to paste your private key into chat. " +
  "Custody depends on which wallet mode you picked: " +
  "Mode A (Q402_PRIVATE_KEY) and Mode B (Q402_AGENTIC_PRIVATE_KEY) sign LOCALLY " +
  "on your machine - those keys never leave your device. " +
  "Mode C (Q402_MULTICHAIN_API_KEY only, no private-key env) is server-managed: " +
  "Q402 holds the Agent Wallet's encrypted private key (AES-256-GCM) and signs on your " +
  "behalf - your MetaMask key is never involved on this side either. " +
  "If a key was already pasted in chat by mistake, treat that wallet as exposed: " +
  "move funds to a fresh wallet and use that new key in ~/.q402/mcp.env going forward.";

/**
 * One-shot setup advisory the AI surfaces during the first-install walkthrough.
 * Three things first-time users hit that are not obvious from the install
 * command alone:
 *   1. The wallet they'll paste a key for should be a FRESH wallet, not the
 *      one holding their main funds. Q402 delegates the EOA via EIP-7702
 *      after the first payment, and that's irreversible without an explicit
 *      q402_clear_delegation step.
 *   2. Hardware wallets (Ledger / Trezor) don't sign EIP-7702 type-4
 *      authorizations yet (as of 2026-Q2). The MCP server takes a raw hex
 *      private key - it can't talk to a Ledger.
 *   3. After the first payment on a chain, MetaMask / OKX show that EOA as
 *      a "Smart account". That's the EIP-7702 delegation marker. Surfacing
 *      this BEFORE the first payment heads off the predictable "why does
 *      my wallet look different now?" support ticket.
 */
const FIRST_INSTALL_ADVISORY = [
  "Tip: a separate MetaMask account dedicated to Q402 keeps your existing balances and history " +
    "tidy - it's a quick \"+ Add account\" in MetaMask. Q402 works with any EOA you control, though.",
  "After your first payment, that wallet will show 'Smart account' in MetaMask / OKX. That's " +
    "EIP-7702 delegation (Q402's gasless settlement mechanism), reversible anytime via " +
    "q402_clear_delegation.",
  "Hardware wallets (Ledger / Trezor) can't sign EIP-7702 type-4 authorizations yet, so they're " +
    "not supported in Q402 today - a hot wallet works.",
  "To export the key in MetaMask: open the account menu → Account details → Show private key. " +
    "Paste the 0x... string into ~/.q402/mcp.env in your editor (never into chat).",
];

// The "after a live payment" version of this heads-up lives on the
// PaySummary itself (see tools/pay.ts) so each tool returns the copy
// inline with its own response shape. Keeping the first-install
// advisory here, the post-payment one in pay.ts.


// Internal helpers -------------------------------------------------------

function envSource(name: string): EnvSlot["source"] {
  if (process.env[name] !== undefined) return "process";
  if (Q402_ENV_FILE_KEYS.has(name))    return "file";
  if (ENV[name] !== undefined)         return "file"; // belt-and-suspenders
  return "unset";
}

function envSlot(name: string, purpose: string): EnvSlot {
  const source = envSource(name);
  return { set: source !== "unset", source, purpose };
}

function mask(key: string | null | undefined): string {
  if (!key || key.length < 12) return key ?? "";
  return `${key.slice(0, 12)}...${key.slice(-4)}`;
}

function detectPhase(): Phase {
  const anyKey = !!(CONFIG.trialApiKey || CONFIG.multichainApiKey || CONFIG.legacyApiKey);
  // Per-slot live detection - CONFIG.apiKeyKind reads only the aliased
  // single slot (multichain ?? trial ?? legacy), so a mixed state like
  // multichain=q402_test_typo + trial=q402_live_real would classify as
  // "test" and skip live-check, even though BNB pays would actually
  // settle live via the trial slot. Look at each scope's key directly.
  const anyLiveKey =
    classifyApiKey(CONFIG.trialApiKey) === "live" ||
    classifyApiKey(CONFIG.multichainApiKey) === "live" ||
    classifyApiKey(CONFIG.legacyApiKey) === "live";
  const modes = detectAgenticModes();
  const hasAnyValidSigningPath = modes.count > 0;

  // Truly empty install: no env file, no keys, no PK. Force first-install
  // even if Q402_ENABLE_REAL_PAYMENTS=1 leaked in from the MCP registry
  // default - otherwise that single flag alone would push a brand-new user
  // into the needs-completion branch and the agent would skip the file-
  // creation flow that lives behind first-install.
  if (
    !Q402_ENV_FILE_PRESENT &&
    !anyKey &&
    !CONFIG.privateKey &&
    !CONFIG.agenticPrivateKey
  ) {
    return "first-install";
  }

  // Live-check requires AT LEAST ONE valid signing path (Mode A real-EOA PK,
  // Mode B Agent Wallet PK, or Mode C server-managed via live apiKey). The
  // template ships placeholders that are truthy but won't pass
  // isValidPrivateKey, so this also screens out the unedited template.
  const allEssentials =
    anyKey && hasAnyValidSigningPath && CONFIG.realPaymentsRequested && anyLiveKey;
  if (allEssentials) return "live-check";

  // Any concrete signal of in-progress setup - a key, a PK (even
  // placeholder), or an env file the user created - counts as partial.
  // Note: realPaymentsRequested is deliberately NOT a phase signal here.
  // It defaults to 1 via server.json, so leaning on it would put empty
  // installs into needs-completion (see the first-install short-circuit
  // above).
  if (
    anyKey ||
    CONFIG.privateKey ||
    CONFIG.agenticPrivateKey ||
    Q402_ENV_FILE_PRESENT
  ) {
    return "needs-completion";
  }
  return "first-install";
}

async function verifyOneKey(
  scope: KeyVerifyResult["scope"],
  envVar: string,
  apiKey: string,
): Promise<KeyVerifyResult> {
  const url = `${CONFIG.relayBaseUrl}/keys/verify`;
  try {
    const resp = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ apiKey }),
      signal:  AbortSignal.timeout(10_000),
    });
    // 429 means the user (or their tooling) is hammering verify, not that
    // the key is invalid. The previous behaviour folded both cases into
    // the generic "HTTP 429 → verified as invalid" warning, which sent
    // users on a wild-goose chase to rotate a perfectly good key. Split
    // the message so the agent can tell the user to wait instead.
    if (resp.status === 429) {
      return {
        scope, envVar, apiKeyMasked: mask(apiKey), valid: false,
        error: "rate limited by relay - wait 60s and re-run q402_doctor",
      };
    }
    if (!resp.ok) {
      return { scope, envVar, apiKeyMasked: mask(apiKey), valid: false, error: `HTTP ${resp.status}` };
    }
    const body = await resp.json() as {
      valid?:           boolean;
      error?:           string;        // surfaced on rotated / sub-expired / trial-expired
      plan?:            string;
      remainingCredits?: number;
      isTrial?:         boolean;
      trialExpiresAt?:  string;
      trialDaysLeft?:   number;
    };
    const result: KeyVerifyResult = {
      scope,
      envVar,
      apiKeyMasked:    mask(apiKey),
      valid:           body.valid ?? false,
      // Propagate the relay's specific reason ("API key has been rotated",
      // "Subscription expired", "Trial expired") so the user gets the
      // exact failure mode instead of a generic "verified as invalid".
      error:           body.valid === false ? body.error : undefined,
      plan:            body.plan,
      remainingCredits: body.remainingCredits,
      isTrial:         body.isTrial,
      trialExpiresAt:  body.trialExpiresAt,
      trialDaysLeft:   body.trialDaysLeft,
    };
    // Slot-mismatch warnings - Trial key in Multichain slot SILENTLY consumes
    // paid quota, Multichain key in Trial slot bypasses free-BNB sponsorship.
    // Both work but are user-error footguns; surface them in the report so
    // the AI can suggest the move.
    if (scope === "multichain" && body.isTrial) {
      result.slotWarning =
        "Trial-tier key found in Q402_MULTICHAIN_API_KEY slot. This works but " +
        "you'll lose the auto-routing benefit (BNB free via Trial). Move the key " +
        "to Q402_TRIAL_API_KEY in ~/.q402/mcp.env.";
    } else if (scope === "trial" && body.isTrial === false && body.plan && body.plan !== "trial") {
      result.slotWarning =
        "Paid Multichain-tier key found in Q402_TRIAL_API_KEY slot. BNB payments " +
        "will burn your paid quota instead of using free Trial sponsorship. " +
        "Move the key to Q402_MULTICHAIN_API_KEY in ~/.q402/mcp.env.";
    }
    return result;
  } catch (e) {
    return {
      scope,
      envVar,
      apiKeyMasked: mask(apiKey),
      valid:        false,
      error:        e instanceof Error ? e.message : String(e),
    };
  }
}

/** Probes /keys/verify with a deliberately-invalid body. Q402's relay
 *  exists on every deployment, including self-hosts, so this is a more
 *  honest "is the relay actually responding?" check than hitting a
 *  /health endpoint that might not be wired up. We expect a 400 (missing
 *  apiKey) - anything in [400, 500) confirms the host is alive and the
 *  Next.js handler is mounted. 5xx or network errors mark it unreachable. */
async function pingRelay(): Promise<DoctorReport["relay"]> {
  const url = `${CONFIG.relayBaseUrl}/keys/verify`;
  const t0  = Date.now();
  try {
    const resp = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    "{}",
      signal:  AbortSignal.timeout(10_000),
    });
    // 400 = "apiKey required" - the route is alive and rejecting our
    // intentionally-empty body. 429 also counts as alive (rate-limited
    // means the route exists). Only 5xx (or a thrown fetch) marks it
    // unreachable.
    const reachable = resp.status >= 200 && resp.status < 500;
    return { url, reachable, latencyMs: Date.now() - t0 };
  } catch (e) {
    return {
      url,
      reachable: false,
      latencyMs: Date.now() - t0,
      error:     e instanceof Error ? e.message : String(e),
    };
  }
}

async function fetchDelegation(address: string): Promise<DelegationState[]> {
  const url = `${CONFIG.relayBaseUrl}/wallet/delegation-status?address=${address}`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) {
      return CHAIN_KEYS.map(chain => ({ chain, delegated: false, error: `HTTP ${resp.status}` }));
    }
    const body = await resp.json() as { chains?: Record<string, { delegated: boolean; impl?: string; error?: string }> };
    return CHAIN_KEYS.map(chain => {
      const s = body.chains?.[chain];
      if (!s) return { chain, delegated: false, error: "missing from response" };
      return { chain, delegated: s.delegated, impl: s.impl, error: s.error };
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return CHAIN_KEYS.map(chain => ({ chain, delegated: false, error }));
  }
}

// -- Main entry ------------------------------------------------------------

export async function runDoctor(): Promise<DoctorReport> {
  const phase = detectPhase();

  // Env file diagnostic. The file's perm warning is already printed to stderr
  // at module load by loadQ402EnvFile(); here we surface (a) whether the file
  // exists so the AI can decide whether to offer creation, and (b) any read
  // error captured by config.ts - e.g. permission denied or size cap hit.
  // Without (b), `envFile.exists: true` paired with an unreadable file would
  // leave the user with "the file is there, why doesn't anything work?".
  const envFileReadError = getQ402EnvFileReadError();
  const envFile: DoctorReport["envFile"] = {
    path:   Q402_ENV_FILE_PATH,
    exists: Q402_ENV_FILE_PRESENT,
    warning: envFileReadError ?? undefined,
  };

  const envState: Record<string, EnvSlot> = {
    Q402_TRIAL_API_KEY: envSlot(
      "Q402_TRIAL_API_KEY",
      "Free Trial - BNB only, 2,000 sponsored TX. Get at https://q402.quackai.ai/event",
    ),
    Q402_MULTICHAIN_API_KEY: envSlot(
      "Q402_MULTICHAIN_API_KEY",
      "Paid Multichain - all 12 chains, per-chain Gas Tank. Get at https://q402.quackai.ai/payment",
    ),
    Q402_PRIVATE_KEY: envSlot(
      "Q402_PRIVATE_KEY",
      "Mode A signing key - your real EOA's private key (e.g. MetaMask). EIP-7702 " +
      "delegates your wallet to Q402 impl. Signs LOCALLY, never leaves your device.",
    ),
    Q402_AGENTIC_PRIVATE_KEY: envSlot(
      "Q402_AGENTIC_PRIVATE_KEY",
      "Mode B signing key - your Agent Wallet's exported private key from the " +
      "dashboard. Signs LOCALLY, never leaves your device. Your MetaMask stays untouched.",
    ),
    Q402_AGENT_WALLET_ADDRESS: envSlot(
      "Q402_AGENT_WALLET_ADDRESS",
      "Mode C target - lowercased Agent Wallet address when you hold multiple. " +
      "Omit to use the server-default wallet. No PK needed; the server signs.",
    ),
    Q402_ENABLE_REAL_PAYMENTS: envSlot(
      "Q402_ENABLE_REAL_PAYMENTS",
      "Must be '1' to allow real TX. Anything else = test response (fake hash).",
    ),
  };

  // Note: CONFIG.legacyApiKey IS still consulted by detectPhase + verify
  // dispatch so an old integration setting Q402_API_KEY keeps working
  // unchanged. We deliberately don't surface it in the diagnostic -
  // teaching a third env var to first-time users only muddies the
  // Trial-vs-Multichain decision they actually have to make.

  // Missing list - what's needed for live mode. Mode-aware: the user only
  // needs A PK if they're driving Mode A (real EOA) or Mode B (Agent Wallet
  // local). Mode C (server-managed Agent Wallet) needs no PK at all - the
  // server holds the encrypted Agent Wallet key.
  const modes = detectAgenticModes();
  const missing: string[] = [];
  if (!CONFIG.trialApiKey && !CONFIG.multichainApiKey && !CONFIG.legacyApiKey) {
    missing.push(
      "An API key (Q402_TRIAL_API_KEY for free BNB OR Q402_MULTICHAIN_API_KEY for paid 12-chain)",
    );
  }

  // Signing path: at least one of A/B/C must be available. If none, tell
  // the user about all three options so they can pick. Placeholder PKs
  // ("0x...") are truthy but fail isValidPrivateKey - flag that separately
  // since the fix is different (paste a real key vs. choose a mode).
  if (modes.count === 0) {
    const pkAPlaceholder = !!CONFIG.privateKey && !isValidPrivateKey(CONFIG.privateKey);
    const pkBPlaceholder = !!CONFIG.agenticPrivateKey && !isValidPrivateKey(CONFIG.agenticPrivateKey);
    if (pkAPlaceholder) {
      missing.push(
        "Q402_PRIVATE_KEY is set but malformed (expected 0x + 64 hex chars). " +
        "Looks like the placeholder '0x...' is still in ~/.q402/mcp.env - paste a real key in your editor.",
      );
    } else if (pkBPlaceholder) {
      missing.push(
        "Q402_AGENTIC_PRIVATE_KEY is set but malformed (expected 0x + 64 hex chars). " +
        "Paste your exported Agent Wallet private key (https://q402.quackai.ai/dashboard → Agent tab → Export).",
      );
    } else {
      missing.push(
        "A signing path. Pick ONE: (A) Q402_PRIVATE_KEY = your MetaMask EOA's " +
        "private key; (B) Q402_AGENTIC_PRIVATE_KEY = your exported Agent Wallet " +
        "private key from the dashboard (Mode B keeps your MetaMask untouched); " +
        "or (C) just use a live paid Q402_MULTICHAIN_API_KEY and let Q402 sign " +
        "with your server-managed Agent Wallet (no PK on your machine).",
      );
    }
  }

  if (!CONFIG.realPaymentsRequested) {
    // server.json declares `default: "1"` for this var as of v0.5.11, but
    // not every MCP client passes registry defaults through - Codex without
    // an explicit env_vars allow-list, raw stdio bridges, etc. won't.
    // When the user's API key + signing path are otherwise fine but the
    // flag is unset, the most likely cause is "client stripped the default"
    // - so tell them to pin it explicitly in the file rather than chase
    // the registry layer.
    const haveAnyApi = !!(CONFIG.trialApiKey || CONFIG.multichainApiKey || CONFIG.legacyApiKey);
    if (haveAnyApi && modes.count > 0) {
      missing.push(
        "Q402_ENABLE_REAL_PAYMENTS=1 - your other config looks fine, but your MCP " +
        "client isn't passing the registry default through. Add the line " +
        "Q402_ENABLE_REAL_PAYMENTS=1 to ~/.q402/mcp.env explicitly and restart.",
      );
    } else {
      missing.push("Q402_ENABLE_REAL_PAYMENTS=1");
    }
  }

  // Recommended actions for the client to execute. First-install gets two
  // actions: (1) make the parent dir explicit so weaker AI clients on
  // Windows don't trip on a missing `~/.q402/`, (2) write the env file.
  // Later phases get none - env edits are manual.
  const recommendedActions: RecommendedAction[] = [];
  if (!envFile.exists) {
    // Belt-and-suspenders: even if the client's write_file tool honors a
    // create-parent-dir flag, emit an explicit shell action so every client
    // (including ones that only have bash, not a structured fs.write tool)
    // has a path forward. Windows variant uses New-Item -ItemType Directory.
    recommendedActions.push({
      id:                  "ensure-q402-dir",
      type:                "shell",
      shell:               'mkdir -p "$HOME/.q402"',
      shellWindows:        'powershell -Command "New-Item -ItemType Directory -Force -Path $env:USERPROFILE\\.q402 | Out-Null"',
      requiresUserConfirm: false,
      description:         "Ensure the ~/.q402 directory exists before writing the secrets file.",
    });
    recommendedActions.push({
      id:                  "create-env-file",
      type:                "write_file",
      path:                Q402_ENV_FILE_PATH,
      content:             ENV_FILE_TEMPLATE,
      requiresUserConfirm: true,
      description:         "Create ~/.q402/mcp.env with placeholder values, then open it in the user's editor.",
      ifExists:            "skip",
    });
  }

  const warnings: string[] = [];

  // Shadow warning: a process.env export silently hides any value in
  // ~/.q402/mcp.env for the same key. Users who think editing the file
  // will help are about to be very confused, so flag it loudly.
  // `Q402_ENV_FILE_KEYS_ALL` = every key in the file. `Q402_ENV_FILE_KEYS`
  // = the subset whose process.env wasn't already set - i.e. the keys
  // that survived the merge. The shadowed set is the complement.
  for (const name of Q402_ENV_FILE_KEYS_ALL) {
    if (process.env[name] !== undefined && !Q402_ENV_FILE_KEYS.has(name)) {
      warnings.push(
        `${name} is set in both your shell (process.env) AND ~/.q402/mcp.env - ` +
        "the shell value wins. Editing the file will have NO effect until you " +
        `\`unset ${name}\` in your shell (or update the shell value to match).`,
      );
    }
  }

  // Legacy upgrade landmine: if the user has Q402_API_KEY set (pre-0.5.0
  // single-env model) AND Q402_ENABLE_REAL_PAYMENTS was *not* explicitly
  // set by them (i.e. it's coming from the registry default of 1 since
  // v0.5.11), warn them. The 0.5.12+ default flip means their next
  // q402_pay can silently settle real funds on the legacy key. They
  // didn't opt into that - it became opt-out behind their back.
  const enableExplicit =
    process.env.Q402_ENABLE_REAL_PAYMENTS !== undefined ||
    Q402_ENV_FILE_KEYS_ALL.has("Q402_ENABLE_REAL_PAYMENTS");
  if (CONFIG.legacyApiKey && CONFIG.realPaymentsRequested && !enableExplicit) {
    warnings.push(
      "You have a legacy Q402_API_KEY set, and Q402_ENABLE_REAL_PAYMENTS " +
      "wasn't explicitly set by you - so it's defaulting to 1 (real payments) " +
      "since v0.5.11. To stay in sandbox while you check this, add " +
      "`Q402_ENABLE_REAL_PAYMENTS=0` to ~/.q402/mcp.env (or your shell) and " +
      "restart the MCP client.",
    );
  }

  // Picker the AI surfaces to the user the moment doctor runs for the
  // first time. Three signing modes, in plain English, with a clear
  // default - designed so a user who just installed `@quackai/q402-mcp`
  // and ran `q402_doctor` can answer "which mode?" without reading any
  // docs. The AI is instructed to echo the question + options verbatim
  // and accept the user's "A", "B", or "C" pick.
  const walletModePicker = {
    question: "How would you like Q402 to sign your payments?",
    helpText:
      "Pick once - you can change later by editing ~/.q402/mcp.env. " +
      "Most users want C (simplest).",
    recommendedPick:
      modes.modeC && !modes.modeA && !modes.modeB
        ? "C"
        : modes.primary ?? "C",
    options: [
      {
        pick: "C" as const,
        title: "Q402 server signs for me (recommended, simplest)",
        description:
          "Q402 holds an encrypted Agent Wallet for you. You only set an API key - " +
          "no private key in your env, no MetaMask popup, no Smart-account marker on your wallet. " +
          "Best for AI agents, automations, and anyone who just wants payments to work. " +
          "One-shot pays accept either key below; recurring schedules require the paid Multichain " +
          "key on every chain (BNB included).",
        env: ["Q402_MULTICHAIN_API_KEY (paid - required for recurring)", "or Q402_TRIAL_API_KEY (free BNB, one-shot pays only)"],
        privateKeyRequired: false,
      },
      {
        pick: "B" as const,
        title: "I'll export the Agent Wallet's private key and sign locally",
        description:
          "Same Agent Wallet as Mode C, but YOU hold the private key. Export it from the " +
          "dashboard once. MCP signs locally so the key never leaves your machine. Your MetaMask " +
          "is never touched.",
        env: ["Q402_AGENTIC_PRIVATE_KEY (export from dashboard)", "+ Q402_MULTICHAIN_API_KEY or Q402_TRIAL_API_KEY"],
        privateKeyRequired: true,
      },
      {
        pick: "A" as const,
        title: "Use my own EOA (MetaMask) as the signer",
        description:
          "Your existing wallet signs directly. EIP-7702 delegates it to Q402 for the call - " +
          "your wallet shows a 'Smart account' marker after first use (normal, reversible). Best for " +
          "power users who want their MetaMask address to be the on-chain payer. Use a FRESH wallet - " +
          "not the one with your main funds.",
        env: ["Q402_PRIVATE_KEY (your EOA's private key)", "+ Q402_MULTICHAIN_API_KEY or Q402_TRIAL_API_KEY"],
        privateKeyRequired: true,
      },
    ],
  };

  // Short-circuit phases that don't need live RPC calls.
  if (phase !== "live-check") {
    return {
      package: PACKAGE_NAME,
      version: PACKAGE_VERSION,
      phase,
      ready:   false,
      envFile,
      envState,
      walletModePicker,
      missing,
      warnings,
      recommendedActions,
      greeting:
        phase === "first-install"
          ? `Q402 MCP is installed (v${PACKAGE_VERSION}).`
          : `Q402 MCP is installed (v${PACKAGE_VERSION}) - partially configured.`,
      nextStep:
        phase === "first-install"
          ? "Show userInstructions verbatim to the user; do NOT show agentInstructions verbatim (it's prescription for you, the AI)."
          : "Tell the user which env vars are still missing (from the 'missing' list) and how to add them to ~/.q402/mcp.env. Show userInstructions for the human-readable steps.",
      agentInstructions:
        phase === "first-install"
          ? "[AI-ONLY - do not show this paragraph to the user verbatim] Multi-turn flow: (1) Briefly tell the user MCP is installed. (2) Ask one yes/no question - 'Want me to create your Q402 settings file?'. (3) On yes, execute recommendedActions IN ORDER: first `ensure-q402-dir` shell action (bash on macOS/Linux, PowerShell on Windows via shellWindows variant), then `create-env-file` write_file action. (4) Open the file in the user's editor - `code` works for VS Code / Cursor / Cline (e.g. `code ~/.q402/mcp.env`); `open` on macOS, `start` on Windows, `xdg-open` on Linux as fallback. (5) Help the user pick a wallet mode (A=Q402_PRIVATE_KEY real EOA, B=Q402_AGENTIC_PRIVATE_KEY exported Agent Wallet PK, C=API key only with server-managed Agent Wallet). If they're an AI agent / automation user, gently default to B or C; if they're a power user who wants their existing EOA to be the signer, A is fine. Walk through filling in the chosen mode's variable + the API key one at a time. (6) Do NOT accept key values via chat - direct the user to edit the file in their editor. BEFORE they paste any private key (Mode A OR Mode B), surface the `advisories` array: fresh wallet, Smart-account-in-MetaMask heads-up (Mode A only), hardware wallets unsupported, MetaMask key-export path (Mode A) or dashboard Export button (Mode B). (7) After they save, tell them to restart the MCP client - per-client restart verb: Claude Desktop → quit + relaunch; Codex → exit + relaunch; Cursor → Cmd/Ctrl+Shift+P → 'Developer: Reload Window'; Cline → reload VS Code window. (8) Have them re-invoke 'Set up Q402' to confirm. Keep the conversation tight: one decision per turn, plain language, never echo this paragraph."
          : "[AI-ONLY - do not show this paragraph to the user verbatim] User has SOME env set. List the missing items (from `missing`) in plain language. Tell them to edit ~/.q402/mcp.env and uncomment / fill the relevant line, then restart the MCP client. Restart verb per client: Claude Desktop → quit + relaunch; Codex → exit + relaunch; Cursor → Cmd/Ctrl+Shift+P → 'Developer: Reload Window'; Cline → reload VS Code window.",
      userInstructions:
        phase === "first-install"
          ? [
              "Q402 is installed. To start sending payments you need (1) an API key and (2) a wallet to sign with.",
              "I'll create a settings file for you - say yes and I'll set it up + open it in your editor.",
              "Get a free API key at https://q402.quackai.ai/event (BNB Chain only, 2,000 sponsored transactions).",
              "There are 3 wallet modes - pick one:" +
                " (A) your MetaMask EOA's private key (simplest, but your account will be marked 'Smart account' after first payment);" +
                " (B) export an Agent Wallet's private key from the dashboard (keeps your MetaMask untouched, recommended for AI agents);" +
                " (C) on a paid plan, use the server-managed Agent Wallet - just set the API key, no private key needed.",
              "Use a FRESH wallet for Mode A - don't use the one holding your main funds. The 'Smart account' marker is normal (EIP-7702 delegation, reversible via q402_clear_delegation).",
              "Paste your key + wallet private key INTO THE FILE (in your editor) - never paste a private key into this chat.",
              "Save the file, restart your MCP client, then ask me 'Verify Q402' to confirm.",
            ]
          : [
              "Q402 is installed but a few env vars are still missing.",
              "Open ~/.q402/mcp.env in your editor and fill in the lines I list below.",
              "Save the file, then restart your MCP client (close + reopen Claude/Codex, or Cmd/Ctrl+Shift+P → Reload Window for Cursor/Cline).",
              "Then ask me 'Verify Q402' to re-check.",
            ],
      securityNotice: SECURITY_NOTICE,
      // Advisories are useful in BOTH first-install and needs-completion:
      // a user who already pasted an API key but hasn't yet added their
      // private key is exactly the audience that needs the "MetaMask
      // export path" + "Smart-account-is-normal" heads-up. Suppressing
      // them once any env was set (the pre-0.5.12 behaviour) left a
      // gap right at the moment they were most useful.
      advisories: FIRST_INSTALL_ADVISORY,
    };
  }

  // -- live-check phase: hit the relay ------------------------------------
  // Derive wallet from private key (still local - no network). Preserve
  // the underlying ethers parse error so the user sees "invalid hex"
  // instead of a generic "wallet derivation failed" - those messages save
  // real debugging time (e.g. "got 65 chars not 64" tells you you pasted
  // an extra char; "non-hex character" tells you you copied a stray
  // smart-quote from a chat client).
  let walletAddress: string | undefined;
  let walletError:   string | undefined;
  // Mode C only (no PK in env, server signs): there's nothing to
  // derive locally. Skipping the parse avoids a misleading
  // "Q402_PRIVATE_KEY malformed" warning on an install that
  // deliberately holds no private key.
  if (CONFIG.privateKey) {
    try {
      walletAddress = new Wallet(CONFIG.privateKey).address;
    } catch (e) {
      walletError = e instanceof Error ? e.message : String(e);
      warnings.push(
        `Q402_PRIVATE_KEY is set but does not parse as a 32-byte hex key: ${walletError}. ` +
        "Open ~/.q402/mcp.env in your editor and paste a real key (0x + 64 hex chars). " +
        "Live calls will fail until this is fixed.",
      );
    }
  }

  // Verify each present key in parallel.
  const verifyTargets: Array<{ scope: KeyVerifyResult["scope"]; envVar: string; key: string }> = [];
  if (CONFIG.trialApiKey)      verifyTargets.push({ scope: "trial",      envVar: "Q402_TRIAL_API_KEY",      key: CONFIG.trialApiKey });
  if (CONFIG.multichainApiKey) verifyTargets.push({ scope: "multichain", envVar: "Q402_MULTICHAIN_API_KEY", key: CONFIG.multichainApiKey });
  if (verifyTargets.length === 0 && CONFIG.legacyApiKey) {
    verifyTargets.push({ scope: "legacy", envVar: "Q402_API_KEY", key: CONFIG.legacyApiKey });
  }

  // delegation stays `undefined` (not `[]`) when wallet derivation failed,
  // so the AI can distinguish "12 chains all undelegated" from "we couldn't
  // even ask because the private key is bad".
  //
  // F9 mitigation: don't issue a redundant pingRelay() call here when we're
  // already going to verify keys against /keys/verify. If at least one
  // verify gets a response (even an invalid-key 200), the relay is
  // demonstrably reachable. The extra ping was burning a 3rd /keys/verify
  // call against a 20/min IP cap that fast-iterating users were tripping.
  const [keys, delegation] = await Promise.all([
    Promise.all(verifyTargets.map(t => verifyOneKey(t.scope, t.envVar, t.key))),
    walletAddress ? fetchDelegation(walletAddress) : Promise.resolve<DelegationState[] | undefined>(undefined),
  ]);
  // Derive a relay snapshot from the verify responses we already have.
  // If even one verify returned a response (k.error doesn't pattern-match
  // a network failure), the relay is up - no separate ping needed. If all
  // verifies failed with a network error OR we had no verify targets at all,
  // fall back to an explicit pingRelay() so the user still gets reachability
  // info on a totally-unconfigured-key system.
  const anyResponse = keys.some(k => !k.error || !/timeout|unreachable|ENOTFOUND|ECONN/i.test(k.error));
  const relay = anyResponse && keys.length > 0
    ? { url: `${CONFIG.relayBaseUrl}/keys/verify`, reachable: true }
    : await pingRelay();

  // Promote slot-mismatch warnings into the top-level warnings array so the
  // AI sees them without having to walk the keys[] array.
  for (const k of keys) if (k.slotWarning) warnings.push(k.slotWarning);
  // Low quota guidance + propagated relay errors.
  for (const k of keys) {
    if (typeof k.remainingCredits === "number" && k.remainingCredits === 0) {
      warnings.push(
        `${k.envVar} has 0 credits remaining. ` +
        (k.isTrial
          ? "Trial allotment exhausted - upgrade to a Multichain plan at https://q402.quackai.ai/payment."
          : "Paid plan quota exhausted - top up at https://q402.quackai.ai/dashboard?tab=billing."),
      );
    } else if (typeof k.remainingCredits === "number" && k.remainingCredits > 0 && k.remainingCredits < 50) {
      warnings.push(
        `${k.envVar} has only ${k.remainingCredits} credits left - top up before you run out.`,
      );
    }
    if (!k.valid) {
      // body.error from the relay carries the specific reason (rotated /
      // sub-expired / trial-expired / rate limited). Surface it instead
      // of the generic "check the key value" message, which sent users
      // chasing the wrong fix in earlier versions. For Trial expired
      // specifically, the relay now returns trialExpiresAt on the invalid
      // branch too - fold it into the user-visible message so "expired"
      // gets paired with the exact date.
      const isTrialExpired = (k.error ?? "").toLowerCase().includes("trial expired");
      if (isTrialExpired && k.trialExpiresAt) {
        const exp = new Date(k.trialExpiresAt);
        const days = Math.floor((Date.now() - exp.getTime()) / 86_400_000);
        const ago = days > 0 ? ` (${days} day${days === 1 ? "" : "s"} ago)` : "";
        warnings.push(
          `${k.envVar}: Trial expired on ${exp.toISOString().slice(0, 10)}${ago}. ` +
          "Upgrade to a Multichain plan at https://q402.quackai.ai/payment.",
        );
      } else {
        warnings.push(
          k.error
            ? `${k.envVar}: ${k.error}.`
            : `${k.envVar} verified as invalid by the relay - check the key value in ~/.q402/mcp.env.`,
        );
      }
    }
  }
  if (relay && !relay.reachable) {
    warnings.push(
      `Q402 relay at ${relay.url} is unreachable. ` +
      "Check your network or override with Q402_RELAY_BASE_URL if you self-host.",
    );
  }

  const ready = warnings.length === 0 && keys.some(k => k.valid);

  // Mode summary - surface the three signing paths and which one the
  // current env actually drives. Pre-this-version doctor only echoed
  // Q402_PRIVATE_KEY in envState; Mode B (Q402_AGENTIC_PRIVATE_KEY) +
  // Mode C (apiKey-only) users got no signal at all and asked "do I
  // need a private key?". This block tells them, in plain words, which
  // mode the install is wired for and what the alternatives look like.
  const activeModes: Array<{ mode: "A" | "B" | "C"; label: string; rationale: string }> = [];
  if (modes.modeA) activeModes.push({
    mode: "A" as const,
    label: "Real EOA (Q402_PRIVATE_KEY)",
    rationale: "Your MetaMask wallet signs directly. EIP-7702 delegates it to Q402 for the call.",
  });
  if (modes.modeB) activeModes.push({
    mode: "B" as const,
    label: "Agent Wallet local (Q402_AGENTIC_PRIVATE_KEY)",
    rationale: "Your exported Agent Wallet PK signs locally. Your MetaMask stays untouched.",
  });
  if (modes.modeC) activeModes.push({
    mode: "C" as const,
    label: "Server-mediated Agent Wallet (apiKey only)",
    rationale: "No PK in your env. Q402's server holds the encrypted Agent Wallet key and signs for you.",
  });
  // Recommended primary: order matches detectAgenticModes.primary -
  // Mode B if PK present, else Mode A if EOA PK present, else Mode C
  // when a live apiKey is configured. We surface a short user-facing
  // recommendation so a first-time install knows which path to pick.
  const recommendedMode: "A" | "B" | "C" | "none" =
    modes.primary ?? (CONFIG.apiKey?.startsWith("q402_live_") ? "C" : "none");
  const walletModes = {
    available: activeModes,
    count:     modes.count,
    primary:   modes.primary,
    /** Plain-English picker that the AI should echo when the user asks
     *  "which mode do I use?" or "do I need a private key?". */
    recommendation:
      recommendedMode === "C"
        ? "You're configured for Mode C - Q402's server signs with your Agent Wallet. No private key needed. Simplest path; recommended for most users. (One-shot pays accept either Trial or Multichain keys; recurring schedules require the paid Multichain key on every chain.)"
        : recommendedMode === "B"
          ? "You're configured for Mode B - your exported Agent Wallet PK signs locally. Your MetaMask is never touched."
          : recommendedMode === "A"
            ? "You're configured for Mode A - your MetaMask EOA signs directly. EIP-7702 delegates it to Q402 for the call. (If the Smart-account banner in MetaMask is a concern, switch to Mode B or C.)"
            : "No signing path configured yet. Easiest: set Q402_MULTICHAIN_API_KEY (paid, recommended) - covers one-shot pays and recurring schedules across all 12 chains. Q402_TRIAL_API_KEY alone unlocks one-shot pays on BNB only; recurring requires the paid key.",
    /** All three modes documented so the AI can answer "what are my
     *  options?" without re-deriving from envState. */
    catalog: [
      { mode: "A" as const, label: "Real EOA",            envVar: "Q402_PRIVATE_KEY",          needsPk: true,  bestFor: "Power users who want their MetaMask to be the on-chain signer." },
      { mode: "B" as const, label: "Agent Wallet local",  envVar: "Q402_AGENTIC_PRIVATE_KEY",  needsPk: true,  bestFor: "Users who want Agent Wallet automation but keep custody of the PK." },
      { mode: "C" as const, label: "Server-mediated",     envVar: "(none)",                    needsPk: false, bestFor: "Most users. No PK in env; Q402 holds the Agent Wallet key encrypted server-side." },
    ],
  };

  return {
    package: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    phase,
    ready,
    envFile,
    envState,
    walletModes,
    missing,
    wallet:            walletAddress ? { address: walletAddress } : undefined,
    keys,
    delegation,
    relay,
    warnings,
    recommendedActions,
    greeting: ready
      ? `Q402 MCP is ready (v${PACKAGE_VERSION}).`
      : `Q402 MCP is installed but has ${warnings.length} issue${warnings.length === 1 ? "" : "s"} to address.`,
    nextStep: ready
      ? "Show userInstructions verbatim. Then offer to make a small test quote (q402_quote) to confirm everything works end-to-end."
      : "Walk the user through each warning in order. Show userInstructions verbatim for the cleanup steps.",
    agentInstructions: ready
      ? "[AI-ONLY - do not show this paragraph to the user verbatim] Live mode is fully configured. Summarize the wallet address (mask middle), plan tier(s), remaining quota, and any non-zero delegation counts to the user as a checklist. Offer a tiny test (q402_quote, not q402_pay) to confirm. Don't echo the full keys array verbatim - pick the most useful 2-3 fields per scope."
      : "[AI-ONLY - do not show this paragraph to the user verbatim] Walk the user through each warning IN ORDER, plain language. For slot-mismatch warnings, the fix is editing ~/.q402/mcp.env and restarting the client (Cursor / Cline: reload window; Claude / Codex: quit + relaunch). Surface body.error strings from any verify failure as the user-visible reason (e.g. 'your Trial expired 3 days ago', 'API key has been rotated') - don't generic-out to 'check the key value'.",
    userInstructions: ready
      ? [
          walletAddress
            ? `Your wallet: ${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`
            : modes.modeC && !modes.modeA && !modes.modeB
              ? "Wallet: server-managed (Mode C) - Q402 holds your Agent Wallet key. No local wallet to show."
              : "(wallet derive failed - check Q402_PRIVATE_KEY or Q402_AGENTIC_PRIVATE_KEY in ~/.q402/mcp.env)",
          "Q402 is live. You can now ask me to quote, pay, batch-pay, or check Trust Receipts.",
          "Want me to run a quick gas comparison across all 12 chains as a smoke test?",
          "Need to chain-test against sandbox without changing keys? Set Q402_ENABLE_REAL_PAYMENTS=0 in ~/.q402/mcp.env and restart - every q402_pay returns a fake hash until you flip it back to 1.",
        ]
      : [
          `Q402 has ${warnings.length} issue${warnings.length === 1 ? "" : "s"} to fix:`,
          ...warnings.map(w => `• ${w}`),
          "Open ~/.q402/mcp.env, fix the lines above, save, then restart your MCP client (Cursor/Cline: Cmd/Ctrl+Shift+P → Reload Window; Claude/Codex: quit + relaunch). Then ask me 'Verify Q402' to re-check.",
        ],
    securityNotice: SECURITY_NOTICE,
    // Carry advisories through live-check too - even a fully-configured
    // user benefits from the "Smart-account in MetaMask is normal" line
    // appearing alongside their first ready state.
    advisories: FIRST_INSTALL_ADVISORY,
  };
}

// -- Tool registration -----------------------------------------------------

export const DOCTOR_TOOL = {
  name: "q402_doctor",
  description:
    "Run a Q402 health check - covers first-install onboarding AND ongoing " +
    "diagnostics in one tool. Read-only, no API key required. Detects the " +
    "current phase (first-install / needs-completion / live-check) and " +
    "tailors output to it. " +
    "\n\n" +
    "Use when the user says any of: \"set up Q402\", \"verify Q402\", \"why " +
    "isn't Q402 working\", \"Q402 status\", \"check Q402\". This is the FIRST " +
    "tool to call after install, BEFORE q402_pay or q402_balance - it tells " +
    "the agent what state the user is in. " +
    "\n\n" +
    "Output uses TWO instruction surfaces - `agentInstructions` (prescription " +
    "for you, the AI - do NOT echo verbatim) and `userInstructions` (plain " +
    "language array you CAN show the user as a numbered list). Always show " +
    "userInstructions; consult agentInstructions privately to decide what to " +
    "ask next + which `recommendedActions` to execute. " +
    "\n\n" +
    "Multi-turn pattern the AI should follow when phase = first-install: " +
    "(1) Tell user MCP is installed. (2) Ask one yes/no question: 'Want me " +
    "to create your secrets file?' (3) On yes, execute recommendedActions IN " +
    "ORDER - first the `ensure-q402-dir` shell action (use shellWindows on " +
    "Windows), then the `create-env-file` write_file action. Then open the " +
    "file in the user's editor (e.g. `code` for VS Code / Cursor / Cline, " +
    "`open` on macOS, `start` on Windows, `xdg-open` on Linux). (4) Guide " +
    "the user through getting an API key (free Trial at " +
    "https://q402.quackai.ai/event OR paid Multichain at /payment) and " +
    "pasting it into the file (in their editor - NEVER in chat). (5) Same " +
    "for the private key. (6) Tell them to save + restart the MCP client " +
    "(per-client restart verb is in agentInstructions). (7) Call q402_doctor " +
    "again to verify. " +
    "\n\n" +
    "Security policy carried in the response: AI MUST surface the " +
    "securityNotice when first walking through setup. If the user pastes a " +
    "private key directly in chat, DO NOT refuse - the exposure already " +
    "happened. Help them by directing them to put it in the file themselves " +
    "(via their editor), and inform them the chat history now contains the " +
    "key (most clients store this locally, some sync to cloud) so they " +
    "should treat the wallet as exposed if it holds valuables. " +
    "\n\n" +
    "Live-check phase additionally returns per-scope quota, EIP-7702 " +
    "delegation state per chain, relay reachability, and slot-mismatch " +
    "warnings (e.g. Trial key in Multichain slot silently burns paid " +
    "quota - surface this to the user).",
  inputSchema: {
    type: "object" as const,
    properties: {},
    additionalProperties: false,
  },
} as const;
