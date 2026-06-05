/**
 * Runtime configuration parsed from environment variables.
 *
 * Two-key model:
 *   Q402_TRIAL_API_KEY       BNB-only sponsored Trial key (free 2k TX).
 *   Q402_MULTICHAIN_API_KEY  Paid 10-chain key backed by per-chain Gas Tank.
 *   Q402_API_KEY             Legacy single-key fallback. Used for both
 *                            scopes when the two scoped envs are unset.
 *
 * Sandbox-default by design — `q402_pay` only performs a real on-chain
 * transaction when *all three* conditions hold for the scope being used:
 *   1. The scope-resolved key is set and starts with `q402_live_`
 *   2. `Q402_ENABLE_REAL_PAYMENTS=1`
 *   3. `Q402_PRIVATE_KEY` is set
 *
 * Any other state falls back to sandbox: a deterministic-looking fake txHash
 * is returned so an agent can complete its workflow, but no funds move and no
 * relay credit is consumed.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir }                            from "node:os";
import { join }                               from "node:path";
import { isAddress }                          from "ethers";

/**
 * Optional dotenv-style file at `~/.q402/mcp.env`. When present, its
 * `Q402_*` entries are merged into the process env that `loadConfig()`
 * reads. Process env wins on conflicts so existing shell-export setups
 * (and Codex `env_vars` allow-lists) stay authoritative.
 *
 * Why we read this directly instead of asking the user to wire shell
 * sourcing through every MCP client:
 *   - The MCP server is spawned as a subprocess by Claude / Codex /
 *     Cursor / Cline. Subprocesses inherit env from their parent, not
 *     from arbitrary files on disk — so a `~/.q402/mcp.env` would be
 *     invisible without each client either inlining secrets in config
 *     or the user maintaining shell-source plumbing per client.
 *   - Reading the file here gives a single, client-agnostic install
 *     pattern: drop one file in your home dir, every MCP client just
 *     works. Same approach AWS CLI / Stripe CLI / gh CLI use.
 *   - The `q402_doctor` tool generates and seeds this file on first
 *     install via a `recommendedActions` payload the client executes
 *     with its own filesystem tool.
 *
 * Filter: only `Q402_*` keys are imported, so a stray `PATH=...` in
 * the file can't poison the MCP server's environment.
 */
const Q402_ENV_FILE = join(homedir(), ".q402", "mcp.env");

/**
 * Dotenv-style parser for the Q402 secrets file. Exported with a path
 * argument so tests can drive it against tmpdir fixtures without having
 * to monkey-patch `os.homedir()`. Production callers use the no-arg
 * `loadQ402EnvFile()` below, which targets the canonical
 * `~/.q402/mcp.env` location.
 */
/** Module-level read-error capture. The loader doesn't throw on read
 *  failure (we want sandbox fallback to stay safe), but the doctor needs
 *  to surface "your file is unreadable" to the user — so we stash the
 *  error message here at module load. `null` = no error / not yet loaded. */
let lastReadError: string | null = null;

/** Exposed so the doctor can surface a stderr warning to the user via
 *  `envFile.warning` instead of leaving a silent gap. */
export function getQ402EnvFileReadError(): string | null {
  return lastReadError;
}

/** Hard cap on the file size we'll buffer into memory. The file is
 *  expected to be ~1 KB of flat key=value pairs; anything larger is
 *  either malicious or pointed at the wrong path. Without this guard a
 *  symlink at `~/.q402/mcp.env` aimed at a 1 GB log file would OOM-
 *  crash the MCP server on every spawn. 64 KB is several thousand env
 *  rows — fine ceiling. */
const MAX_ENV_FILE_BYTES = 64 * 1024;

export function loadQ402EnvFileFromPath(path: string): Record<string, string> {
  lastReadError = null;
  if (!existsSync(path)) return {};

  // World-readable perms on a secrets file is a footgun. Warn (best-
  // effort) on Unix; Windows uses ACLs so the bit check is meaningless
  // there and would just produce false-positive warnings.
  if (process.platform !== "win32") {
    try {
      const mode = statSync(path).mode & 0o777;
      if (mode & 0o077) {
        process.stderr.write(
          `[q402-mcp] warning: ${path} is readable by group/other ` +
          `(mode ${mode.toString(8)}). Run: chmod 600 ${path}\n`,
        );
      }
    } catch { /* stat failure is non-fatal — just skip the warning */ }
  }

  // Bail before allocating an unbounded buffer if the file is too large.
  try {
    const size = statSync(path).size;
    if (size > MAX_ENV_FILE_BYTES) {
      const msg = `file is ${size} bytes (max ${MAX_ENV_FILE_BYTES}); refusing to load. ` +
        "Check ~/.q402/mcp.env — is it a misdirected log file or symlink?";
      lastReadError = msg;
      process.stderr.write(`[q402-mcp] warning: ${msg}\n`);
      return {};
    }
  } catch { /* if stat fails here, readFileSync below will report a clearer error */ }

  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    const msg = `could not read ${path}: ${e instanceof Error ? e.message : String(e)}`;
    lastReadError = msg;
    process.stderr.write(`[q402-mcp] warning: ${msg}\n`);
    return {};
  }

  // Strip a leading UTF-8 BOM (U+FEFF). Windows Notepad writes the BOM
  // by default when saving "ANSI"/"UTF-8 with signature" files — without
  // this strip, the first key `Q402_TRIAL_API_KEY` becomes
  // `﻿Q402_TRIAL_API_KEY`, fails the `Q402_` prefix filter, and
  // silently drops the user into sandbox with no warning.
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);

  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    if (!k.startsWith("Q402_")) continue;          // namespace filter
    // Raw value with inline-comment handling. Standard .env convention:
    // an unquoted `#` followed by whitespace (or end of line) starts a
    // trailing comment. Without this, `Q402_ENABLE_REAL_PAYMENTS=1 # live`
    // would parse the value as the string `"1 # live"` and silently keep
    // the server in sandbox (since "1 # live" !== "1"). For quoted
    // values we leave `#` intact — a user who quoted the value clearly
    // wants the literal characters.
    let rawVal = t.slice(eq + 1).trim();
    const quoted = /^(['"])(.*)\1\s*(?:#.*)?$/.exec(rawVal);
    if (quoted) {
      rawVal = quoted[2]!;
    } else {
      // Strip ` #` (or tab-#) onward; preserve `#` inside the value if
      // not preceded by whitespace (e.g. a key that happens to contain
      // `#` — unlikely, but cheap to preserve).
      const hashIdx = rawVal.search(/\s#/);
      if (hashIdx >= 0) rawVal = rawVal.slice(0, hashIdx).trimEnd();
    }
    // Treat `KEY=` (empty value) as unset. The doctor template ships
    // the api-key + private-key lines uncommented but empty so users
    // only have to paste the value (no `#` to remove). An empty value
    // should propagate as "unset" to `envSlot()` / `detectPhase()`
    // rather than landing in FILE_ENV as a literal empty string —
    // otherwise Q402_ENV_FILE_KEYS would lie about it being configured.
    if (rawVal === "") continue;
    out[k] = rawVal;
  }
  return out;
}

function loadQ402EnvFile(): Record<string, string> {
  return loadQ402EnvFileFromPath(Q402_ENV_FILE);
}

/**
 * Effective env: file values, then process env overrides on top. Frozen
 * so downstream `loadConfig()` reads a stable snapshot — and so tests
 * can patch `process.env` for one-shot scenarios without us silently
 * recomputing under their feet.
 */
const FILE_ENV = loadQ402EnvFile();
export const ENV: Readonly<Record<string, string | undefined>> = Object.freeze({
  ...FILE_ENV,
  ...process.env,
});

/** Path the doctor + tests reference. Exposed so callers don't re-derive it. */
export const Q402_ENV_FILE_PATH = Q402_ENV_FILE;

/** True when ~/.q402/mcp.env was readable at module load. Tracked separately
 *  from `ENV` because once values are merged, the per-key origin is lost. */
export const Q402_ENV_FILE_PRESENT = existsSync(Q402_ENV_FILE);

/** Set of env-var names whose value came from the file (i.e. not from
 *  process.env). Useful for `q402_doctor` to label sources without
 *  recomputing the file parse. */
export const Q402_ENV_FILE_KEYS: ReadonlySet<string> = Object.freeze(
  new Set(
    Object.keys(FILE_ENV).filter(k => process.env[k] === undefined),
  ),
) as ReadonlySet<string>;

/** EVERY key the file defines — even ones that process.env shadows.
 *  q402_doctor uses this to surface the "your shell export is hiding
 *  your edits to ~/.q402/mcp.env" footgun: if a key appears in both
 *  process.env AND the file, the user editing the file gets nothing,
 *  and Q402_ENV_FILE_KEYS alone hides the shadow because it filters
 *  shadowed keys out. */
export const Q402_ENV_FILE_KEYS_ALL: ReadonlySet<string> = Object.freeze(
  new Set(Object.keys(FILE_ENV)),
) as ReadonlySet<string>;

export type Mode = "sandbox" | "live";
export type KeyScope = "trial" | "multichain";

/** Tool-level scope hint. "auto" is the default and dispatches by chain. */
export type KeyScopeRequest = "auto" | KeyScope;

export interface Config {
  /** Trial-scope key (BNB-only). Null if Q402_TRIAL_API_KEY unset. */
  trialApiKey: string | null;
  /** Multichain-scope key (10 chains). Null if Q402_MULTICHAIN_API_KEY unset. */
  multichainApiKey: string | null;
  /** Legacy single-env fallback. Null if Q402_API_KEY unset. */
  legacyApiKey: string | null;
  /**
   * Back-compat alias: prefers multichain, then trial, then legacy. Many
   * existing callers (`apiKeyKind`, sandbox reason) only need to know "is
   * SOME live key configured" — those continue to read `apiKey` directly.
   */
  apiKey: string | null;
  apiKeyKind: "live" | "test" | "missing";
  /**
   * Q402_PRIVATE_KEY — user's real EOA private key (Mode A). The signer
   * is the user's MetaMask/OKX wallet, EIP-7702 delegated to Q402 impl.
   */
  privateKey: string | null;
  /**
   * Q402_AGENTIC_PRIVATE_KEY — Agent Wallet's exported private key
   * (Mode B). The signer is the Agent Wallet itself; the user's
   * MetaMask is untouched.
   */
  agenticPrivateKey: string | null;
  /**
   * Q402_AGENT_WALLET_ADDRESS — Mode C only. Lowercased Agent Wallet
   * address (the hex `0x…` that the dashboard shows on the Agent
   * Wallet card) picking which of the user's wallets the server
   * should sign with. Multi-wallet supports up to 10 per owner.
   * Null means "use the user's default wallet". Per-call `walletId`
   * argument on `q402_pay` / `q402_batch_pay` overrides this env.
   *
   * Was named `Q402_WALLET_ID` in v0.6.0 — too generic, easily
   * confused with the user's MetaMask address or an apiKey
   * identifier. Renamed in v0.6.1 to make the namespace + content
   * shape explicit. The Config field name (`walletId`) stays so
   * internal callers (pay.ts, agentic-info.ts) don't churn.
   */
  walletId: string | null;
  realPaymentsRequested: boolean;
  /** Effective default mode after combining all gates (using the apiKey alias). */
  mode: Mode;
  relayBaseUrl: string;
  maxAmountPerCallUsd: number;
  /** Lowercase recipient allowlist (empty = no allowlist). */
  allowedRecipients: string[];
}

// Default relay endpoint. Override via Q402_RELAY_BASE_URL env when
// running against a self-hosted Q402 deployment or a non-canonical
// environment.
const DEFAULT_RELAY_BASE = "https://q402.quackai.ai/api";
const DEFAULT_MAX_AMOUNT = 200;

/**
 * Classify an API key string by its visible prefix. Exported so
 * `q402_doctor` can detect "any scoped key is live" per-slot instead of
 * relying on `CONFIG.apiKeyKind`, which is computed from the aliased
 * single `apiKey` slot below and would mis-report when a user has e.g.
 * Q402_MULTICHAIN_API_KEY=q402_test_typo + Q402_TRIAL_API_KEY=q402_live_real.
 * In that mixed state `apiKeyKind` resolves against the multichain test
 * key (alias winner) and reads "test", but the trial key is live for
 * BNB-scope `q402_pay` — so detectPhase must look at each slot directly.
 */
export function classifyApiKey(k: string | null): Config["apiKeyKind"] {
  if (!k) return "missing";
  if (k.startsWith("q402_live_")) return "live";
  if (k.startsWith("q402_test_")) return "test";
  return "missing";
}

function parseAllowedRecipients(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(s => s.length > 0 && isAddress(s));
}

function parseMaxAmount(raw: string | undefined): number {
  if (!raw) return DEFAULT_MAX_AMOUNT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_AMOUNT;
  return n;
}

export function loadConfig(): Config {
  const trialApiKey      = ENV.Q402_TRIAL_API_KEY      ?? null;
  const multichainApiKey = ENV.Q402_MULTICHAIN_API_KEY ?? null;
  const legacyApiKey     = ENV.Q402_API_KEY            ?? null;
  // Prefer the multichain key for the legacy `apiKey` slot so existing
  // callers default to the broader scope. Falls back to trial then legacy.
  const apiKey = multichainApiKey ?? trialApiKey ?? legacyApiKey;
  const apiKeyKind = classifyApiKey(apiKey);
  const privateKey = ENV.Q402_PRIVATE_KEY ?? null;
  const agenticPrivateKey = ENV.Q402_AGENTIC_PRIVATE_KEY ?? null;
  // walletId is just stored lowercased here; we don't validate its
  // shape (the server returns 404 on a bad walletId, which is a
  // friendlier error than this MCP guessing).
  // v0.6.1 rename: `Q402_AGENT_WALLET_ADDRESS` is the canonical name.
  // `Q402_WALLET_ID` is accepted for one release as a soft-migration
  // path. The canonical name wins on collision so a user explicitly
  // moving to v0.6.1 isn't shadowed by a stale env.
  const walletIdRaw =
    ENV.Q402_AGENT_WALLET_ADDRESS ?? ENV.Q402_WALLET_ID;
  if (!ENV.Q402_AGENT_WALLET_ADDRESS && ENV.Q402_WALLET_ID) {
    process.stderr.write(
      "[q402-mcp] Q402_WALLET_ID is deprecated — rename to Q402_AGENT_WALLET_ADDRESS. " +
        "Old name will be removed in a future release.\n",
    );
  }
  const walletId =
    typeof walletIdRaw === "string" && walletIdRaw.length > 0
      ? walletIdRaw.toLowerCase()
      : null;
  const realPaymentsRequested = ENV.Q402_ENABLE_REAL_PAYMENTS === "1";

  // `mode` mirrors the per-scope live check used by `isLiveModeFor()` at
  // payment time, NOT the aliased `apiKeyKind`. The alias picks one slot
  // (`multichain ?? trial ?? legacy`) for backward-compat, but the actual
  // live gate per call resolves the scope from the chain+recipient set
  // and looks at that scope's key independently. If any one scope's key
  // is live, q402_pay can settle on-chain — `mode=live` should reflect
  // that, otherwise stderr says `mode=sandbox` while live BNB pays
  // actually go through.
  const anyLiveKey =
    classifyApiKey(trialApiKey) === "live" ||
    classifyApiKey(multichainApiKey) === "live" ||
    classifyApiKey(legacyApiKey) === "live";
  // Live default reflects "is at least one signer key configured" the
  // same way isLiveModeFor() does — either Mode A (Q402_PRIVATE_KEY)
  // or Mode B (Q402_AGENTIC_PRIVATE_KEY) is enough. Mode C is a live
  // path too but only resolves per-call (apiKey live + endpoint
  // reachable), so we don't try to encode it in this default snapshot.
  const hasAnySignerKey =
    (typeof privateKey === "string" && privateKey.length > 0) ||
    (typeof agenticPrivateKey === "string" && agenticPrivateKey.length > 0);
  const live = realPaymentsRequested && anyLiveKey && hasAnySignerKey;

  return {
    trialApiKey,
    multichainApiKey,
    legacyApiKey,
    apiKey,
    apiKeyKind,
    privateKey,
    agenticPrivateKey,
    walletId,
    realPaymentsRequested,
    mode: live ? "live" : "sandbox",
    relayBaseUrl: (ENV.Q402_RELAY_BASE_URL ?? DEFAULT_RELAY_BASE).replace(/\/$/, ""),
    maxAmountPerCallUsd: parseMaxAmount(ENV.Q402_MAX_AMOUNT_PER_CALL),
    allowedRecipients: parseAllowedRecipients(ENV.Q402_ALLOWED_RECIPIENTS),
  };
}

/**
 * Snapshot of which Agent Wallet modes the current env can drive.
 *
 *   Mode A — `Q402_PRIVATE_KEY` set: real user EOA signs locally, EIP-7702
 *            delegation to Q402 impl. Existing flow.
 *   Mode B — `Q402_AGENTIC_PRIVATE_KEY` set: Agent Wallet's exported pk
 *            signs locally. User MetaMask never touched.
 *   Mode C — only `Q402_*_API_KEY` set, no private key: server-mediated
 *            send through /api/wallet/agentic/send. Q402 holds the key.
 *
 * When more than one mode is configured, callers (q402_pay, batch_pay)
 * MUST ask the user which wallet to use. The MCP server cannot guess.
 */
export interface AgenticModes {
  modeA: boolean;
  modeB: boolean;
  modeC: boolean;
  /** Number of modes available (0..3). */
  count: number;
  /** First-available mode, or null when none. Used as the implicit pick
   *  in cases where the caller hasn't explicitly disambiguated. */
  primary: "A" | "B" | "C" | null;
}

export function detectAgenticModes(c: Config = CONFIG): AgenticModes {
  const modeA = isValidPrivateKey(c.privateKey);
  const modeB = isValidPrivateKey(c.agenticPrivateKey);
  // Mode C is available whenever a live multichain apiKey is configured —
  // independent of Modes A/B. Earlier revisions gated Mode C behind
  // `!modeA && !modeB`, but that hid the server-managed wallet from any
  // user who *also* had a private key set, which is the most common
  // dev install. q402_pay's disambiguation step handles the "multiple
  // modes available" UX correctly when more than one is available.
  const modeC = c.apiKey !== null && c.apiKey.startsWith("q402_live_");
  let count = 0;
  if (modeA) count++;
  if (modeB) count++;
  if (modeC) count++;
  const primary: AgenticModes["primary"] =
    modeB ? "B" : modeA ? "A" : modeC ? "C" : null;
  return { modeA, modeB, modeC, count, primary };
}

/** Single shared instance — env is parsed once at process start. */
export const CONFIG = loadConfig();

/**
 * Resolve the API key to use for a (chain, scope) request.
 *
 * Auto routing rule (when scope === "auto"):
 *   - chain === "bnb" AND Q402_TRIAL_API_KEY set  → trial
 *   - otherwise                                    → multichain
 *   - if the chosen scope has no key, fall back to legacyApiKey
 *
 * This rule applies UNIFORMLY to `q402_pay` (single) AND `q402_batch_pay`
 * (batch). The batch-vs-single distinction used to live in this resolver
 * (batches always picked multichain to avoid the Trial 5-recipient cap),
 * but that surprised users by silently charging the paid pool for what
 * they expected to be a free Trial flow. The current design is honest:
 * BNB always prefers Trial when a Trial key is set; if a batch would
 * exceed the Trial cap, the batch-pay tool surfaces an `ambiguous` status
 * BEFORE executing so the agent can ask the user how to handle it
 * (`keyScope: "trial"` to use 5, `keyScope: "multichain"` for all, or two
 * separate calls to split). See `batch-pay.ts` for the ambiguity gate.
 *
 * NEVER THROWS. The MCP server is sandbox-default by design: any failure to
 * resolve a live key returns a null `apiKey` and a `sandboxReason` so the
 * caller can drop into the sandbox path with a useful hint. The explicit
 * `confirm: true` argument + per-call USD cap + recipient allowlist remain
 * the load-bearing user-safety guards.
 *
 * The one trial-specific guard kept here is the chain check: `keyScope: "trial"`
 * with a non-BNB chain is an impossible combination — even with a valid Trial
 * key the server would 403 with TRIAL_BNB_ONLY. We surface that intent error
 * via `sandboxReason` (still no throw) so the agent sees a clear hint.
 */
export interface ResolvedKey {
  /** Null when no live key is available; caller falls back to sandbox. */
  apiKey: string | null;
  /** The scope that was actually picked (after auto-routing). */
  scope: KeyScope;
  /** Whether the resolution fell back to the legacy single-env key. */
  fromLegacyFallback: boolean;
  /** When apiKey is null, this explains *why* and how the user can fix it. */
  sandboxReason?: string;
}

export function resolveApiKey(
  chain: string,
  scope: KeyScopeRequest = "auto",
): ResolvedKey {
  const effectiveScope: KeyScope =
    scope === "auto"
      ? // Unified rule for single + batch: BNB prefers Trial when set,
        // everything else uses Multichain. Batch cap ambiguity is handled
        // in batch-pay.ts BEFORE this resolver runs.
        chain === "bnb" && CONFIG.trialApiKey
        ? "trial"
        : "multichain"
      : scope;

  if (effectiveScope === "trial") {
    if (chain !== "bnb") {
      // Impossible scope. No live key resolves; sandbox with a clear hint.
      return {
        apiKey: null,
        scope: "trial",
        fromLegacyFallback: false,
        sandboxReason:
          `keyScope="trial" requested but chain="${chain}" — Trial keys support ` +
          `BNB Chain only. Drop keyScope (or set keyScope="multichain") to use ` +
          `the paid Multichain key on ${chain}.`,
      };
    }
    const key = CONFIG.trialApiKey ?? CONFIG.legacyApiKey;
    if (!key) {
      return {
        apiKey: null,
        scope: "trial",
        fromLegacyFallback: false,
        sandboxReason:
          "keyScope='trial' requested but neither Q402_TRIAL_API_KEY nor " +
          "Q402_API_KEY is set. Get a free Trial key at https://q402.quackai.ai/event.",
      };
    }
    return { apiKey: key, scope: "trial", fromLegacyFallback: !CONFIG.trialApiKey };
  }

  // multichain scope
  const key = CONFIG.multichainApiKey ?? CONFIG.legacyApiKey;
  if (!key) {
    return {
      apiKey: null,
      scope: "multichain",
      fromLegacyFallback: false,
      sandboxReason:
        (scope === "multichain"
          ? "keyScope='multichain' requested but neither Q402_MULTICHAIN_API_KEY"
          : `chain="${chain}" routes to the Multichain scope but neither Q402_MULTICHAIN_API_KEY`) +
        " nor Q402_API_KEY is set. Activate a paid plan at https://q402.quackai.ai/payment to get one.",
    };
  }
  return { apiKey: key, scope: "multichain", fromLegacyFallback: !CONFIG.multichainApiKey };
}

/** Exactly 0x + 64 hex chars. Used to reject placeholders like `0x...` that
 *  would otherwise slip through the live-mode gate and explode inside
 *  ethers' Wallet constructor on the first signing attempt. */
const PRIVATE_KEY_RE = /^0x[a-fA-F0-9]{64}$/;

/**
 * Live-mode gate for a specific resolved key. Returns true ONLY when:
 *   - `resolved.apiKey` starts with `q402_live_`
 *   - `Q402_ENABLE_REAL_PAYMENTS=1`
 *   - AT LEAST ONE valid signing key is configured. That's either
 *     `Q402_PRIVATE_KEY` (Mode A — user EOA) OR
 *     `Q402_AGENTIC_PRIVATE_KEY` (Mode B — exported Agent Wallet PK).
 *     Mode C (server-mediated) doesn't sign locally so it short-circuits
 *     ahead of this gate in `pay.ts` / `batch-pay.ts`.
 *
 * The PK format check matters: the 0.5.6 doctor template shipped with
 * `Q402_PRIVATE_KEY=0x...` as a placeholder, and the previous version
 * of this function (which only checked truthiness) let the literal
 * string `"0x..."` through — q402_pay then threw inside `new Wallet()`
 * instead of dropping into a friendly sandbox response. Validating the
 * shape here means a placeholder-tripped live mode now resolves to
 * sandbox + a clear setupHint.
 *
 * Earlier revisions hard-required `Q402_PRIVATE_KEY` regardless of
 * effective mode. That blocked Mode B users (no MetaMask key, just the
 * exported Agent Wallet PK) from ever going live — making Mode B
 * useless as a prod option. The signer-selection step downstream picks
 * the correct PK based on the chosen `walletMode`, so the gate here
 * only needs to confirm that SOME valid signing key is available.
 */
export function isLiveModeFor(resolved: ResolvedKey): boolean {
  if (!resolved.apiKey) return false;
  if (!CONFIG.realPaymentsRequested) return false;
  const hasMode_A_Key =
    typeof CONFIG.privateKey === "string" && PRIVATE_KEY_RE.test(CONFIG.privateKey);
  const hasMode_B_Key =
    typeof CONFIG.agenticPrivateKey === "string" && PRIVATE_KEY_RE.test(CONFIG.agenticPrivateKey);
  if (!hasMode_A_Key && !hasMode_B_Key) return false;
  return resolved.apiKey.startsWith("q402_live_");
}

/** Exposed for `q402_doctor` so it can distinguish "PK missing" from
 *  "PK set but malformed" without re-deriving the regex. */
export const isValidPrivateKey = (s: string | null | undefined): boolean =>
  typeof s === "string" && PRIVATE_KEY_RE.test(s);
