/**
 * Runtime configuration parsed from environment variables.
 *
 * Two-key model:
 *   Q402_TRIAL_API_KEY       BNB-only sponsored Trial key (free 2k TX).
 *   Q402_MULTICHAIN_API_KEY  Paid 8-chain key backed by per-chain Gas Tank.
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

import { isAddress } from "ethers";

export type Mode = "sandbox" | "live";
export type KeyScope = "trial" | "multichain";

/** Tool-level scope hint. "auto" is the default and dispatches by chain. */
export type KeyScopeRequest = "auto" | KeyScope;

export interface Config {
  /** Trial-scope key (BNB-only). Null if Q402_TRIAL_API_KEY unset. */
  trialApiKey: string | null;
  /** Multichain-scope key (9 chains). Null if Q402_MULTICHAIN_API_KEY unset. */
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
  privateKey: string | null;
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
const DEFAULT_MAX_AMOUNT = 5;

function classifyApiKey(k: string | null): Config["apiKeyKind"] {
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
  const trialApiKey      = process.env.Q402_TRIAL_API_KEY      ?? null;
  const multichainApiKey = process.env.Q402_MULTICHAIN_API_KEY ?? null;
  const legacyApiKey     = process.env.Q402_API_KEY            ?? null;
  // Prefer the multichain key for the legacy `apiKey` slot so existing
  // callers default to the broader scope. Falls back to trial then legacy.
  const apiKey = multichainApiKey ?? trialApiKey ?? legacyApiKey;
  const apiKeyKind = classifyApiKey(apiKey);
  const privateKey = process.env.Q402_PRIVATE_KEY ?? null;
  const realPaymentsRequested = process.env.Q402_ENABLE_REAL_PAYMENTS === "1";

  const live =
    realPaymentsRequested &&
    apiKeyKind === "live" &&
    typeof privateKey === "string" &&
    privateKey.length > 0;

  return {
    trialApiKey,
    multichainApiKey,
    legacyApiKey,
    apiKey,
    apiKeyKind,
    privateKey,
    realPaymentsRequested,
    mode: live ? "live" : "sandbox",
    relayBaseUrl: (process.env.Q402_RELAY_BASE_URL ?? DEFAULT_RELAY_BASE).replace(/\/$/, ""),
    maxAmountPerCallUsd: parseMaxAmount(process.env.Q402_MAX_AMOUNT_PER_CALL),
    allowedRecipients: parseAllowedRecipients(process.env.Q402_ALLOWED_RECIPIENTS),
  };
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

/**
 * Live-mode gate for a specific resolved key. Returns true when the key
 * starts with `q402_live_` AND a private key is set AND the user has opted
 * into real payments. A null `apiKey` (sandbox-only resolution) always
 * returns false.
 */
export function isLiveModeFor(resolved: ResolvedKey): boolean {
  if (!resolved.apiKey) return false;
  if (!CONFIG.realPaymentsRequested) return false;
  if (!CONFIG.privateKey) return false;
  return resolved.apiKey.startsWith("q402_live_");
}
