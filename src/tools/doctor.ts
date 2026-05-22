/**
 * q402_doctor — read-only, no API key required.
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
 *   1. first-install — no Q402_* envs set. Tool returns a recommendedActions
 *      payload telling the client to write a placeholder ~/.q402/mcp.env file
 *      it can open in the user's editor. Tool DOES NOT write the file itself
 *      — the MCP server has no filesystem access on the user's machine; the
 *      client (Claude Code / Codex CLI / Cursor / Cline) does.
 *   2. needs-completion — some envs set, some missing. Tool returns a
 *      structured list of what's missing + why each one matters.
 *   3. live-check — env complete enough to attempt live. Tool calls
 *      `/keys/verify` and `/wallet/delegation-status` to confirm the API key
 *      is valid, fetch quota, and report per-chain EIP-7702 delegation
 *      state.
 *
 * Security policy carried in the response:
 *   "Q402 never asks you to paste your private key into chat. The MCP server
 *   signs payments LOCALLY on your machine — your key never leaves your
 *   device, never goes to a remote server."
 *
 * The tool description tells the AI to surface this notice whenever
 * walking a user through setup, AND to never refuse a key that's already
 * been pasted in chat (the exposure already happened — write to file +
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
} from "../config.js";
import { CHAIN_KEYS }     from "../chains.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../version.js";

export const DoctorInputSchema = z.object({});
export type  DoctorInput = z.infer<typeof DoctorInputSchema>;

type Phase = "first-install" | "needs-completion" | "live-check";

interface EnvSlot {
  /** Whether the value is present in the resolved env (file OR process). */
  set: boolean;
  /** Source of the value — file ~/.q402/mcp.env, process env, or unset. */
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
  /** Cross-platform shell variants — AI picks one matching the host OS.
   *  When omitted, `shell` is assumed POSIX-compatible. */
  shellWindows?: string;
  /** For "write_file" — body to write. */
  content?:     string;
  /** Whether to ask the user before executing this action. */
  requiresUserConfirm: boolean;
  /** Short label the AI uses when offering the action. */
  description:  string;
  /** For "write_file" only: what to do when the file already exists. */
  ifExists?:    "skip" | "ask-before-overwrite";
}

export interface DoctorReport {
  /** Tool identity — handy for the AI to confirm it's looking at fresh output. */
  package: string;
  version: string;

  /** Computed phase. AI uses this to pick its tone (welcoming vs verifying). */
  phase: Phase;
  /** True only when the server can attempt real on-chain payments right now. */
  ready: boolean;

  /** Env file diagnostic — what we expect at ~/.q402/mcp.env. */
  envFile: {
    path:    string;
    exists:  boolean;
    /** Non-fatal warning (e.g. world-readable perms) — surfaced to user. */
    warning?: string;
  };

  /** Per-env-var slot state. Trial + Multichain are the canonical two — the
   *  legacy single-env fallback (`Q402_API_KEY`) is intentionally NOT
   *  surfaced here. The two-key model is the only one users should reason
   *  about; the fallback exists in config.ts to keep older integrations
   *  working without forcing a flag-day migration, and the doctor stays
   *  silent about it so first-install mental models stay clean. */
  envState: Record<string, EnvSlot>;

  /** Human-readable list of what's still required for live mode. */
  missing: string[];

  /** Live-check phase only — derived wallet address from Q402_PRIVATE_KEY. */
  wallet?: { address: string };

  /** Live-check phase only — per-scope key verification + quota. */
  keys?: KeyVerifyResult[];

  /** Live-check phase only — per-chain EIP-7702 delegation snapshot.
   *  `undefined` when wallet derivation failed (Q402_PRIVATE_KEY malformed);
   *  empty array would falsely read as "all 9 chains undelegated". */
  delegation?: DelegationState[] | undefined;

  /** Live-check phase only — relay reachability + latency. */
  relay?: { url: string; reachable: boolean; latencyMs?: number; error?: string };

  /** Free-form warnings the AI should surface (slot mismatch, quota low, etc.). */
  warnings: string[];

  /** Structured actions the client can execute on the user's filesystem. */
  recommendedActions: RecommendedAction[];

  /** Multi-turn conversation framing — what the AI should say next.
   *  Kept for back-compat with clients that read `nextStep` directly,
   *  but new code should branch on the structured
   *  `agentInstructions` / `userInstructions` pair below. */
  greeting:  string;
  nextStep:  string;

  /** Detailed prescription for the AI itself — the multi-turn flow,
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

  /** Canonical security notice — AI MUST forward this when walking through setup. */
  securityNotice: string;

  /** First-install advisories — fresh-wallet reminder, EIP-7702 "Smart account"
   *  heads-up, hardware-wallet caveat, MetaMask private-key export breadcrumb.
   *  Populated only on the `first-install` phase. */
  advisories?: string[];
}

// ── Env file template ──────────────────────────────────────────────────────
// Secret-bearing lines (API key + PRIVATE_KEY) are commented out so
// saving + restarting the file as-is can't trip live mode by accident.
// Q402_ENABLE_REAL_PAYMENTS=1 IS the default, however — this is safe
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
// edits — when both are real, you're live. Earlier versions of this
// template required a third edit (flip the flag from 0 to 1), but
// users who'd finished the API key + PK paste kept getting stuck in
// sandbox without realising the flag was still 0. The PK regex
// makes that extra friction unnecessary.
const ENV_FILE_TEMPLATE = `# ──────────────────────────────────────────────────────────────────────
# Q402 MCP — secrets
# Read automatically by @quackai/q402-mcp on startup.
# Edit this file in your editor. NEVER paste your private key into chat.
# After editing, restart your MCP client (Codex / Claude / Cursor / Cline).
# ──────────────────────────────────────────────────────────────────────

# ─── API key — uncomment ONE (or both for auto-routing) ───────────────
# Free Trial:        BNB Chain only, 2,000 sponsored TX
# Get one at:        https://q402.quackai.ai/event
# Q402_TRIAL_API_KEY=q402_live_...

# Paid Multichain:   all 9 chains, per-chain Gas Tank
# Get one at:        https://q402.quackai.ai/payment
# Q402_MULTICHAIN_API_KEY=q402_live_...

# ─── Your wallet ──────────────────────────────────────────────────────
# Hex EVM private key (0x + 64 hex chars). Signs payments LOCALLY on
# your machine — never leaves your device, never sent to any server.
# Q402_PRIVATE_KEY=0x...

# ─── Live mode switch ─────────────────────────────────────────────────
#   0 = sandbox (test mode, no funds move — every q402_pay returns a fake hash)
#   1 = real on-chain payments (live mode)
# Default is 1: real payments enabled. This is safe because mode only
# flips to live when BOTH a live API key (q402_live_*) AND a valid
# 32-byte private key are set above. Until you uncomment + paste both,
# you stay in sandbox. Change to 0 to force sandbox even with real
# keys (e.g. for chained testing on a paid plan).
Q402_ENABLE_REAL_PAYMENTS=1

# ─── Q402 relay endpoint ──────────────────────────────────────────────
# Default canonical Q402 deployment. Only change for self-hosted.
Q402_RELAY_BASE_URL=https://q402.quackai.ai/api

# ─── Optional safety guards ───────────────────────────────────────────
# Max USD per single q402_pay call (default: 5)
# Q402_MAX_AMOUNT_PER_CALL=5
#
# Comma-separated lowercase recipient allowlist (unset = any address OK)
# Q402_ALLOWED_RECIPIENTS=0xabc...,0xdef...
`;

const SECURITY_NOTICE =
  "Q402 never asks you to paste your private key into chat. The MCP server " +
  "signs payments LOCALLY on your machine — your key never leaves your device, " +
  "never goes to a remote server. If a key was already pasted in chat by mistake, " +
  "treat the wallet as exposed: move funds to a fresh wallet and use that new " +
  "key in ~/.q402/mcp.env going forward.";

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
 *      private key — it can't talk to a Ledger.
 *   3. After the first payment on a chain, MetaMask / OKX show that EOA as
 *      a "Smart account". That's the EIP-7702 delegation marker. We've seen
 *      users panic at this exact moment; flagging it BEFORE the first
 *      payment heads off the support ticket.
 */
const FIRST_INSTALL_ADVISORY = [
  "Tip: a separate MetaMask account dedicated to Q402 keeps your existing balances and history " +
    "tidy — it's a quick \"+ Add account\" in MetaMask. Q402 works with any EOA you control, though.",
  "After your first payment, that wallet will show 'Smart account' in MetaMask / OKX. That's " +
    "EIP-7702 delegation (Q402's gasless settlement mechanism), reversible anytime via " +
    "q402_clear_delegation.",
  "Hardware wallets (Ledger / Trezor) can't sign EIP-7702 type-4 authorizations yet, so they're " +
    "not supported in Q402 today — a hot wallet works.",
  "To export the key in MetaMask: open the account menu → Account details → Show private key. " +
    "Paste the 0x... string into ~/.q402/mcp.env in your editor (never into chat).",
];

// The "after a live payment" version of this heads-up lives on the
// PaySummary itself (see tools/pay.ts) so each tool returns the copy
// inline with its own response shape. Keeping the first-install
// advisory here, the post-payment one in pay.ts.


// Internal helpers ───────────────────────────────────────────────────────

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
  return `${key.slice(0, 12)}…${key.slice(-4)}`;
}

function detectPhase(): Phase {
  const anyKey   = !!(CONFIG.trialApiKey || CONFIG.multichainApiKey || CONFIG.legacyApiKey);
  const allEssentials =
    anyKey && !!CONFIG.privateKey && CONFIG.realPaymentsRequested && CONFIG.apiKeyKind === "live";
  if (allEssentials) return "live-check";
  if (anyKey || CONFIG.privateKey || CONFIG.realPaymentsRequested) return "needs-completion";
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
        error: "rate limited by relay — wait 60s and re-run q402_doctor",
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
    // Slot-mismatch warnings — Trial key in Multichain slot SILENTLY consumes
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
 *  apiKey) — anything in [400, 500) confirms the host is alive and the
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
    // 400 = "apiKey required" — the route is alive and rejecting our
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

// ── Main entry ────────────────────────────────────────────────────────────

export async function runDoctor(): Promise<DoctorReport> {
  const phase = detectPhase();

  // Env file diagnostic. The file's perm warning is already printed to stderr
  // at module load by loadQ402EnvFile(); here we just surface whether the
  // file exists so the AI can decide whether to offer creation.
  const envFile: DoctorReport["envFile"] = {
    path:   Q402_ENV_FILE_PATH,
    exists: Q402_ENV_FILE_PRESENT,
  };

  const envState: Record<string, EnvSlot> = {
    Q402_TRIAL_API_KEY: envSlot(
      "Q402_TRIAL_API_KEY",
      "Free Trial — BNB only, 2,000 sponsored TX. Get at https://q402.quackai.ai/event",
    ),
    Q402_MULTICHAIN_API_KEY: envSlot(
      "Q402_MULTICHAIN_API_KEY",
      "Paid Multichain — all 9 chains, per-chain Gas Tank. Get at https://q402.quackai.ai/payment",
    ),
    Q402_PRIVATE_KEY: envSlot(
      "Q402_PRIVATE_KEY",
      "Hex EVM private key. Signs LOCALLY on your machine — never leaves your device.",
    ),
    Q402_ENABLE_REAL_PAYMENTS: envSlot(
      "Q402_ENABLE_REAL_PAYMENTS",
      "Must be '1' to allow real TX. Anything else = test response (fake hash).",
    ),
  };

  // Note: CONFIG.legacyApiKey IS still consulted by detectPhase + verify
  // dispatch so an old integration setting Q402_API_KEY keeps working
  // unchanged. We deliberately don't surface it in the diagnostic —
  // teaching a third env var to first-time users only muddies the
  // Trial-vs-Multichain decision they actually have to make.

  // Missing list — what's needed for live mode. Includes the placeholder
  // case: a string like "0x..." is technically set but won't pass the
  // private-key format check, so the user still has work to do.
  const missing: string[] = [];
  if (!CONFIG.trialApiKey && !CONFIG.multichainApiKey && !CONFIG.legacyApiKey) {
    missing.push(
      "An API key (Q402_TRIAL_API_KEY for free BNB OR Q402_MULTICHAIN_API_KEY for paid 9-chain)",
    );
  }
  if (!CONFIG.privateKey) {
    missing.push("Q402_PRIVATE_KEY");
  } else if (!isValidPrivateKey(CONFIG.privateKey)) {
    missing.push(
      "Q402_PRIVATE_KEY is set but malformed (expected 0x + 64 hex chars). " +
      "Looks like the placeholder '0x...' is still in ~/.q402/mcp.env — paste a real key in your editor.",
    );
  }
  if (!CONFIG.realPaymentsRequested) {
    // server.json declares `default: "1"` for this var as of v0.5.11, but
    // not every MCP client passes registry defaults through — Codex without
    // an explicit env_vars allow-list, raw stdio bridges, etc. won't.
    // When the user's API key + PK are otherwise fine but the flag is
    // unset, the most likely cause is "client stripped the default" — so
    // tell them to pin it explicitly in the file rather than chase the
    // registry layer.
    const haveAnyApi = !!(CONFIG.trialApiKey || CONFIG.multichainApiKey || CONFIG.legacyApiKey);
    const havePk    = isValidPrivateKey(CONFIG.privateKey);
    if (haveAnyApi && havePk) {
      missing.push(
        "Q402_ENABLE_REAL_PAYMENTS=1 — your other config looks fine, but your MCP " +
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
  // Later phases get none — env edits are manual.
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
  for (const name of Q402_ENV_FILE_KEYS_ALL) {
    if (process.env[name] !== undefined && Q402_ENV_FILE_KEYS_ALL.has(name) && !Q402_ENV_FILE_KEYS.has(name)) {
      warnings.push(
        `${name} is set in both your shell (process.env) AND ~/.q402/mcp.env — ` +
        "the shell value wins. Editing the file will have NO effect until you " +
        `\`unset ${name}\` in your shell (or update the shell value to match).`,
      );
    }
  }

  // Short-circuit phases that don't need live RPC calls.
  if (phase !== "live-check") {
    return {
      package: PACKAGE_NAME,
      version: PACKAGE_VERSION,
      phase,
      ready:   false,
      envFile,
      envState,
      missing,
      warnings,
      recommendedActions,
      greeting:
        phase === "first-install"
          ? `Q402 MCP is installed (v${PACKAGE_VERSION}).`
          : `Q402 MCP is installed (v${PACKAGE_VERSION}) — partially configured.`,
      nextStep:
        phase === "first-install"
          ? "Show userInstructions verbatim to the user; do NOT show agentInstructions verbatim (it's prescription for you, the AI)."
          : "Tell the user which env vars are still missing (from the 'missing' list) and how to add them to ~/.q402/mcp.env. Show userInstructions for the human-readable steps.",
      agentInstructions:
        phase === "first-install"
          ? "Multi-turn flow: (1) Briefly tell the user MCP is installed. (2) Ask one yes/no question — 'Want me to create your Q402 settings file?'. (3) On yes, execute recommendedActions IN ORDER: first `ensure-q402-dir` shell action (bash on macOS/Linux, PowerShell on Windows via shellWindows variant), then `create-env-file` write_file action. (4) Open the file in the user's editor — `code` works for VS Code / Cursor / Cline (e.g. `code ~/.q402/mcp.env`); `open` on macOS, `start` on Windows, `xdg-open` on Linux as fallback. (5) Walk through filling in the API key (from /event for free Trial or /payment for paid Multichain) and private key one at a time. (6) Do NOT accept key values via chat — direct the user to edit the file in their editor. BEFORE they paste a private key, surface the `advisories` array: fresh wallet, Smart-account-in-MetaMask heads-up, hardware wallets unsupported, MetaMask key-export path. (7) After they save, tell them to restart the MCP client — per-client restart verb: Claude Desktop → quit + relaunch; Codex → exit + relaunch; Cursor → Cmd/Ctrl+Shift+P → 'Developer: Reload Window'; Cline → reload VS Code window. (8) Have them re-invoke 'Set up Q402' to confirm. Keep the conversation tight: one decision per turn, plain language, never echo this paragraph."
          : "User has SOME env set. List the missing items (from `missing`) in plain language. Tell them to edit ~/.q402/mcp.env and uncomment / fill the relevant line, then restart the MCP client. Restart verb per client: Claude Desktop → quit + relaunch; Codex → exit + relaunch; Cursor → Cmd/Ctrl+Shift+P → 'Developer: Reload Window'; Cline → reload VS Code window.",
      userInstructions:
        phase === "first-install"
          ? [
              "Q402 is installed. To start sending payments you need an API key and a wallet.",
              "I'll create a settings file for you — say yes and I'll set it up + open it in your editor.",
              "Get a free API key at https://q402.quackai.ai/event (BNB Chain only, 2,000 sponsored transactions).",
              "Use a FRESH wallet for Q402 — don't use your main wallet. The wallet will be marked 'Smart account' in MetaMask after your first payment (that's normal — Q402 reverses it on demand).",
              "Paste your key + wallet private key INTO THE FILE (in your editor) — never paste a private key into this chat.",
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

  // ── live-check phase: hit the relay ────────────────────────────────────
  // Derive wallet from private key (still local — no network). Preserve
  // the underlying ethers parse error so the user sees "invalid hex"
  // instead of a generic "wallet derivation failed" — those messages save
  // real debugging time (e.g. "got 65 chars not 64" tells you you pasted
  // an extra char; "non-hex character" tells you you copied a stray
  // smart-quote from a chat client).
  let walletAddress: string | undefined;
  let walletError:   string | undefined;
  try {
    walletAddress = new Wallet(CONFIG.privateKey!).address;
  } catch (e) {
    walletError = e instanceof Error ? e.message : String(e);
    warnings.push(
      `Q402_PRIVATE_KEY is set but does not parse as a 32-byte hex key: ${walletError}. ` +
      "Open ~/.q402/mcp.env in your editor and paste a real key (0x + 64 hex chars). " +
      "Live calls will fail until this is fixed.",
    );
  }

  // Verify each present key in parallel.
  const verifyTargets: Array<{ scope: KeyVerifyResult["scope"]; envVar: string; key: string }> = [];
  if (CONFIG.trialApiKey)      verifyTargets.push({ scope: "trial",      envVar: "Q402_TRIAL_API_KEY",      key: CONFIG.trialApiKey });
  if (CONFIG.multichainApiKey) verifyTargets.push({ scope: "multichain", envVar: "Q402_MULTICHAIN_API_KEY", key: CONFIG.multichainApiKey });
  if (verifyTargets.length === 0 && CONFIG.legacyApiKey) {
    verifyTargets.push({ scope: "legacy", envVar: "Q402_API_KEY", key: CONFIG.legacyApiKey });
  }

  // delegation stays `undefined` (not `[]`) when wallet derivation failed,
  // so the AI can distinguish "9 chains all undelegated" from "we couldn't
  // even ask because the private key is bad".
  const [keys, delegation, relay] = await Promise.all([
    Promise.all(verifyTargets.map(t => verifyOneKey(t.scope, t.envVar, t.key))),
    walletAddress ? fetchDelegation(walletAddress) : Promise.resolve<DelegationState[] | undefined>(undefined),
    pingRelay(),
  ]);

  // Promote slot-mismatch warnings into the top-level warnings array so the
  // AI sees them without having to walk the keys[] array.
  for (const k of keys) if (k.slotWarning) warnings.push(k.slotWarning);
  // Low quota guidance + propagated relay errors.
  for (const k of keys) {
    if (typeof k.remainingCredits === "number" && k.remainingCredits === 0) {
      warnings.push(
        `${k.envVar} has 0 credits remaining. ` +
        (k.isTrial
          ? "Trial allotment exhausted — upgrade to a Multichain plan at https://q402.quackai.ai/payment."
          : "Paid plan quota exhausted — top up at https://q402.quackai.ai/dashboard?tab=billing."),
      );
    } else if (typeof k.remainingCredits === "number" && k.remainingCredits > 0 && k.remainingCredits < 50) {
      warnings.push(
        `${k.envVar} has only ${k.remainingCredits} credits left — top up before you run out.`,
      );
    }
    if (!k.valid) {
      // body.error from the relay carries the specific reason (rotated /
      // sub-expired / trial-expired / rate limited). Surface it instead
      // of the generic "check the key value" message, which sent users
      // chasing the wrong fix in earlier versions.
      warnings.push(
        k.error
          ? `${k.envVar}: ${k.error}.`
          : `${k.envVar} verified as invalid by the relay — check the key value in ~/.q402/mcp.env.`,
      );
    }
  }
  if (relay && !relay.reachable) {
    warnings.push(
      `Q402 relay at ${relay.url} is unreachable. ` +
      "Check your network or override with Q402_RELAY_BASE_URL if you self-host.",
    );
  }

  const ready = warnings.length === 0 && keys.some(k => k.valid);

  return {
    package: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    phase,
    ready,
    envFile,
    envState,
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
      ? "Live mode is fully configured. Summarize the wallet address (mask middle), plan tier(s), remaining quota, and any non-zero delegation counts to the user as a checklist. Offer a tiny test (q402_quote, not q402_pay) to confirm. Don't echo the full keys array verbatim — pick the most useful 2-3 fields per scope."
      : "Walk the user through each warning IN ORDER, plain language. For slot-mismatch warnings, the fix is editing ~/.q402/mcp.env and restarting the client (Cursor / Cline: reload window; Claude / Codex: quit + relaunch). Surface body.error strings from any verify failure as the user-visible reason (e.g. 'your Trial expired 3 days ago', 'API key has been rotated') — don't generic-out to 'check the key value'.",
    userInstructions: ready
      ? [
          `Your wallet: ${walletAddress ? walletAddress.slice(0, 6) + "…" + walletAddress.slice(-4) : "(derive failed — check Q402_PRIVATE_KEY)"}`,
          "Q402 is live. You can now ask me to quote, pay, batch-pay, or check Trust Receipts.",
          "Want me to run a quick gas comparison across all 9 chains as a smoke test?",
          "Need to chain-test against sandbox without changing keys? Set Q402_ENABLE_REAL_PAYMENTS=0 in ~/.q402/mcp.env and restart — every q402_pay returns a fake hash until you flip it back to 1.",
        ]
      : [
          `Q402 has ${warnings.length} issue${warnings.length === 1 ? "" : "s"} to fix:`,
          ...warnings.map(w => `• ${w}`),
          "Open ~/.q402/mcp.env, fix the lines above, save, then restart your MCP client (Cursor/Cline: Cmd/Ctrl+Shift+P → Reload Window; Claude/Codex: quit + relaunch). Then ask me 'Verify Q402' to re-check.",
        ],
    securityNotice: SECURITY_NOTICE,
    // Carry advisories through live-check too — even a fully-configured
    // user benefits from the "Smart-account in MetaMask is normal" line
    // appearing alongside their first ready state.
    advisories: FIRST_INSTALL_ADVISORY,
  };
}

// ── Tool registration ─────────────────────────────────────────────────────

export const DOCTOR_TOOL = {
  name: "q402_doctor",
  description:
    "Run a Q402 health check — covers first-install onboarding AND ongoing " +
    "diagnostics in one tool. Read-only, no API key required. Detects the " +
    "current phase (first-install / needs-completion / live-check) and " +
    "tailors output to it. " +
    "\n\n" +
    "Use when the user says any of: \"set up Q402\", \"verify Q402\", \"why " +
    "isn't Q402 working\", \"Q402 status\", \"check Q402\". This is the FIRST " +
    "tool to call after install, BEFORE q402_pay or q402_balance — it tells " +
    "the agent what state the user is in. " +
    "\n\n" +
    "Output uses TWO instruction surfaces — `agentInstructions` (prescription " +
    "for you, the AI — do NOT echo verbatim) and `userInstructions` (plain " +
    "language array you CAN show the user as a numbered list). Always show " +
    "userInstructions; consult agentInstructions privately to decide what to " +
    "ask next + which `recommendedActions` to execute. " +
    "\n\n" +
    "Multi-turn pattern the AI should follow when phase = first-install: " +
    "(1) Tell user MCP is installed. (2) Ask one yes/no question: 'Want me " +
    "to create your secrets file?' (3) On yes, execute recommendedActions IN " +
    "ORDER — first the `ensure-q402-dir` shell action (use shellWindows on " +
    "Windows), then the `create-env-file` write_file action. Then open the " +
    "file in the user's editor (e.g. `code` for VS Code / Cursor / Cline, " +
    "`open` on macOS, `start` on Windows, `xdg-open` on Linux). (4) Guide " +
    "the user through getting an API key (free Trial at " +
    "https://q402.quackai.ai/event OR paid Multichain at /payment) and " +
    "pasting it into the file (in their editor — NEVER in chat). (5) Same " +
    "for the private key. (6) Tell them to save + restart the MCP client " +
    "(per-client restart verb is in agentInstructions). (7) Call q402_doctor " +
    "again to verify. " +
    "\n\n" +
    "Security policy carried in the response: AI MUST surface the " +
    "securityNotice when first walking through setup. If the user pastes a " +
    "private key directly in chat, DO NOT refuse — the exposure already " +
    "happened. Help them by directing them to put it in the file themselves " +
    "(via their editor), and inform them the chat history now contains the " +
    "key (most clients store this locally, some sync to cloud) so they " +
    "should treat the wallet as exposed if it holds valuables. " +
    "\n\n" +
    "Live-check phase additionally returns per-scope quota, EIP-7702 " +
    "delegation state per chain, relay reachability, and slot-mismatch " +
    "warnings (e.g. Trial key in Multichain slot silently burns paid " +
    "quota — surface this to the user).",
  inputSchema: {
    type: "object" as const,
    properties: {},
    additionalProperties: false,
  },
} as const;
