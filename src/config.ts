/**
 * Runtime configuration parsed from environment variables.
 *
 * Sandbox-default by design — `q402_pay` only performs a real on-chain transaction
 * when *all three* conditions hold:
 *   1. `Q402_API_KEY` is set and starts with `q402_live_`
 *   2. `Q402_ENABLE_REAL_PAYMENTS=1`
 *   3. `Q402_PRIVATE_KEY` is set
 *
 * Any other state falls back to sandbox: a deterministic-looking fake txHash is
 * returned so an agent can complete its workflow, but no funds move and no
 * relay credit is consumed.
 */

import { isAddress } from "ethers";

export type Mode = "sandbox" | "live";

export interface Config {
  apiKey: string | null;
  apiKeyKind: "live" | "test" | "missing";
  privateKey: string | null;
  realPaymentsRequested: boolean;
  /** Effective mode after combining all gates. */
  mode: Mode;
  relayBaseUrl: string;
  maxAmountPerCallUsd: number;
  /** Lowercase recipient allowlist (empty = no allowlist). */
  allowedRecipients: string[];
}

// ⚠️ SPRINT-TEMPORARY DEFAULT — revert on merge to main
//
// During the BNB-focus sprint, the canonical site (q402.quackai.ai) is
// still serving `main`, which lacks the email-auth + trial routes. Trial
// users sign up on the sprint preview deploy, so their subscription
// record lives on the preview KV — not on production. An MCP install
// that defaults to https://q402.quackai.ai/api hits a production KV that
// can't see the trial subscription and falls through to a gas-tank
// check, breaking the "Q402 covers gas" promise.
//
// While the sprint is live we point the default at the preview deploy so
// fresh MCP installs land on the same KV as the dashboard issuing keys.
// Users with their own deploy can still override via Q402_RELAY_BASE_URL.
//
// REVERT CHECKLIST (run when merging the sprint branch into main):
//   1. Flip DEFAULT_RELAY_BASE back to "https://q402.quackai.ai/api"
//   2. Bump @quackai/q402-mcp version (currently 0.3.13 carries the
//      preview default; next post-merge release should be ≥ 0.4.0 with
//      the canonical default restored)
//   3. Confirm production KV has the necessary subscription records
//      (Vercel branch swap + env-var consolidation, or KV data sync)
//   4. Republish to npm + update server.json
//
// See docs/sprint-bnb-focus.md for the full sprint reversibility plan.
const DEFAULT_RELAY_BASE = "https://q402-institutional-git-feat-bnb-f-e317ee-bitgett-7677s-projects.vercel.app/api";
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
  const apiKey = process.env.Q402_API_KEY ?? null;
  const apiKeyKind = classifyApiKey(apiKey);
  const privateKey = process.env.Q402_PRIVATE_KEY ?? null;
  const realPaymentsRequested = process.env.Q402_ENABLE_REAL_PAYMENTS === "1";

  const live =
    realPaymentsRequested &&
    apiKeyKind === "live" &&
    typeof privateKey === "string" &&
    privateKey.length > 0;

  return {
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
