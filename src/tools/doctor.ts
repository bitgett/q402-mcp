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

interface RecommendedAction {
  id:           string;
  type:         "write_file";
  path:         string;
  /** When true, create the parent dir before writing. */
  createParentDirs: boolean;
  content:      string;
  /** Whether to ask the user before executing this action. */
  requiresUserConfirm: boolean;
  /** Short label the AI uses when offering the action. */
  description:  string;
  /** If file already exists at `path`, what should the AI do. */
  ifExists:     "skip" | "ask-before-overwrite";
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

  /** Per-env-var slot state. Trial / Multichain are the canonical two; the
   *  legacy Q402_API_KEY slot is only included when actually set. */
  envState: Record<string, EnvSlot>;

  /** Human-readable list of what's still required for live mode. */
  missing: string[];

  /** When set: legacy Q402_API_KEY detected — works but worth migrating. */
  legacyDetected?: string;

  /** Live-check phase only — derived wallet address from Q402_PRIVATE_KEY. */
  wallet?: { address: string };

  /** Live-check phase only — per-scope key verification + quota. */
  keys?: KeyVerifyResult[];

  /** Live-check phase only — per-chain EIP-7702 delegation snapshot. */
  delegation?: DelegationState[];

  /** Live-check phase only — relay reachability + latency. */
  relay?: { url: string; reachable: boolean; latencyMs?: number; error?: string };

  /** Free-form warnings the AI should surface (slot mismatch, quota low, etc.). */
  warnings: string[];

  /** Structured actions the client can execute on the user's filesystem. */
  recommendedActions: RecommendedAction[];

  /** Multi-turn conversation framing — what the AI should say next. */
  greeting:  string;
  nextStep:  string;

  /** Canonical security notice — AI MUST forward this when walking through setup. */
  securityNotice: string;
}

// ── Env file template ──────────────────────────────────────────────────────
// Pre-fills the canonical relay URL so a user with a working API key + private
// key gets a sensible default for self-host fallback. Trial key slot is the
// uncommented default (most first-install users get a free Trial); paid users
// uncomment Q402_MULTICHAIN_API_KEY instead (or in addition for auto-routing).
const ENV_FILE_TEMPLATE = `# ──────────────────────────────────────────────────────────────────────
# Q402 MCP — secrets
# Read automatically by @quackai/q402-mcp on startup.
# Edit this file in your editor. NEVER paste your private key into chat.
# After editing, restart your MCP client (Codex / Claude / Cursor / Cline).
# ──────────────────────────────────────────────────────────────────────

# ─── API key — pick ONE (uncomment the one you have) ──────────────────
# Free Trial:        BNB Chain only, 2,000 sponsored TX
# Get one at:        https://q402.quackai.ai/event
Q402_TRIAL_API_KEY=q402_live_...

# Paid Multichain:   all 9 chains, per-chain Gas Tank
# Get one at:        https://q402.quackai.ai/payment
# Q402_MULTICHAIN_API_KEY=q402_live_...

# ─── Your wallet ──────────────────────────────────────────────────────
# Hex EVM private key. Signs payments LOCALLY on your machine.
# Never leaves your device, never sent to any server.
Q402_PRIVATE_KEY=0x...

# ─── Live mode flag ───────────────────────────────────────────────────
# Must be exactly "1" to allow real on-chain transactions.
# Anything else = test response (fake hash, no funds move).
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
    });
    if (!resp.ok) {
      return { scope, envVar, apiKeyMasked: mask(apiKey), valid: false, error: `HTTP ${resp.status}` };
    }
    const body = await resp.json() as {
      valid?:           boolean;
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

async function pingRelay(): Promise<DoctorReport["relay"]> {
  const url = `${CONFIG.relayBaseUrl}/health`;
  const t0  = Date.now();
  try {
    const resp = await fetch(url, { method: "GET" });
    // /api/health may not exist on older deployments — fall back to "any 2xx
    // or 404 means the host is up; only network errors mark it unreachable".
    const reachable = resp.status < 500;
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
    const resp = await fetch(url);
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

  // Q402_API_KEY (legacy) is only shown when actually set — keeps the
  // first-install diagnostic clean (Trial OR Multichain mental model).
  let legacyDetected: string | undefined;
  if (CONFIG.legacyApiKey) {
    legacyDetected =
      "Q402_API_KEY is set — works as a fallback for both scopes, but the newer " +
      "two-key model (Q402_TRIAL_API_KEY + Q402_MULTICHAIN_API_KEY) gives you " +
      "auto-routing between free Trial (BNB) and paid Multichain. Rename in " +
      "~/.q402/mcp.env when convenient.";
  }

  // Missing list — what's needed for live mode.
  const missing: string[] = [];
  if (!CONFIG.trialApiKey && !CONFIG.multichainApiKey && !CONFIG.legacyApiKey) {
    missing.push(
      "An API key (Q402_TRIAL_API_KEY for free BNB OR Q402_MULTICHAIN_API_KEY for paid 9-chain)",
    );
  }
  if (!CONFIG.privateKey)           missing.push("Q402_PRIVATE_KEY");
  if (!CONFIG.realPaymentsRequested) missing.push("Q402_ENABLE_REAL_PAYMENTS=1");

  // Recommended actions for the client to execute. First-install gets a
  // single file-creation action; later phases get none (manual edits only).
  const recommendedActions: RecommendedAction[] = [];
  if (!envFile.exists) {
    recommendedActions.push({
      id:                  "create-env-file",
      type:                "write_file",
      path:                Q402_ENV_FILE_PATH,
      createParentDirs:    true,
      content:             ENV_FILE_TEMPLATE,
      requiresUserConfirm: true,
      description:         "Create ~/.q402/mcp.env with placeholder values, then open it in the user's editor.",
      ifExists:            "skip",
    });
  }

  const warnings: string[] = [];

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
      legacyDetected,
      warnings,
      recommendedActions,
      greeting:
        phase === "first-install"
          ? `Q402 MCP is installed (v${PACKAGE_VERSION}).`
          : `Q402 MCP is installed (v${PACKAGE_VERSION}) — partially configured.`,
      nextStep:
        phase === "first-install"
          ? "Offer to create ~/.q402/mcp.env. After yes, run the recommendedActions[].write_file action, then open the file in the user's editor (e.g. via `code` / `open` / `start` / `xdg-open`). Then walk through filling in the API key and private key, one at a time. Do NOT accept key values via chat — direct the user to edit the file in their editor."
          : `Tell the user which env vars are still missing (from the 'missing' list) and how to add them to ~/.q402/mcp.env. Restart needed after editing.`,
      securityNotice: SECURITY_NOTICE,
    };
  }

  // ── live-check phase: hit the relay ────────────────────────────────────
  // Derive wallet from private key (still local — no network).
  let walletAddress: string | undefined;
  try {
    walletAddress = new Wallet(CONFIG.privateKey!).address;
  } catch {
    warnings.push("Q402_PRIVATE_KEY is set but does not parse as a 32-byte hex key. Live calls will fail.");
  }

  // Verify each present key in parallel.
  const verifyTargets: Array<{ scope: KeyVerifyResult["scope"]; envVar: string; key: string }> = [];
  if (CONFIG.trialApiKey)      verifyTargets.push({ scope: "trial",      envVar: "Q402_TRIAL_API_KEY",      key: CONFIG.trialApiKey });
  if (CONFIG.multichainApiKey) verifyTargets.push({ scope: "multichain", envVar: "Q402_MULTICHAIN_API_KEY", key: CONFIG.multichainApiKey });
  if (verifyTargets.length === 0 && CONFIG.legacyApiKey) {
    verifyTargets.push({ scope: "legacy", envVar: "Q402_API_KEY", key: CONFIG.legacyApiKey });
  }

  const [keys, delegation, relay] = await Promise.all([
    Promise.all(verifyTargets.map(t => verifyOneKey(t.scope, t.envVar, t.key))),
    walletAddress ? fetchDelegation(walletAddress) : Promise.resolve<DelegationState[]>([]),
    pingRelay(),
  ]);

  // Promote slot-mismatch warnings into the top-level warnings array so the
  // AI sees them without having to walk the keys[] array.
  for (const k of keys) if (k.slotWarning) warnings.push(k.slotWarning);
  // Low quota guidance.
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
    if (!k.valid && !k.error) {
      warnings.push(`${k.envVar} verified as invalid by the relay — check the key value in ~/.q402/mcp.env.`);
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
    legacyDetected,
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
      ? "Summarize the wallet address, plan tier(s), remaining quota, and any non-zero delegation counts to the user as a checklist. Then offer to make a test payment via q402_quote."
      : "Walk the user through each warning in order. For slot-mismatch warnings, the fix is editing ~/.q402/mcp.env and restarting the client.",
    securityNotice: SECURITY_NOTICE,
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
    "Multi-turn pattern the AI should follow when phase = first-install: " +
    "(1) Tell user MCP is installed. (2) Ask one yes/no question: 'Want me " +
    "to create your secrets file at ~/.q402/mcp.env?' (3) On yes, execute " +
    "the recommendedActions[].write_file action using the client's own " +
    "filesystem tool, then open the file in the user's editor (e.g. `code " +
    "~/.q402/mcp.env`, `open` on macOS, `start` on Windows, `xdg-open` on " +
    "Linux). (4) Guide the user through getting an API key (free Trial at " +
    "https://q402.quackai.ai/event OR paid Multichain at /payment) and " +
    "pasting it into the file (in their editor — NEVER in chat). (5) Same " +
    "for the private key. (6) Tell them to save + restart the MCP client. " +
    "(7) Call q402_doctor again to verify. " +
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
