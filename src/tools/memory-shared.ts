/**
 * Shared caller for the Q402 Memory tools (summary / vendor / agent).
 * Read-only + free: ANY live Q402 API key (Trial or Multichain) authenticates
 * the read — Memory is not a paid-only feature. It only ever returns the key
 * owner's own treasury data. Hits POST /api/wallet/agentic/memory-by-key. No
 * private key, no gas, no money moved.
 */
import { CONFIG } from "../config.js";

export function dashboardUrl(): string {
  return CONFIG.relayBaseUrl.replace(/\/api$/, "") + "/dashboard?tab=agent";
}

export async function callMemory(
  action: "summary" | "vendor" | "agent",
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const url = dashboardUrl();

  // Any live key works (Trial or Multichain) — Memory is free + read-only.
  if (!CONFIG.apiKey || !CONFIG.apiKey.startsWith("q402_live_")) {
    return { configured: false, dashboardUrl: url, setupHint: "No live Q402 API key configured. Run q402_doctor to set one up (a free Trial key works)." };
  }

  try {
    const res = await fetch(`${CONFIG.relayBaseUrl}/wallet/agentic/memory-by-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: CONFIG.apiKey, action, ...extra }),
    });
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      return { configured: true, dashboardUrl: url, setupHint: `memory ${action} failed: ${e.error ?? `HTTP ${res.status}`}${e.message ? ` — ${e.message}` : ""}` };
    }
    return { configured: true, dashboardUrl: url, ...((await res.json()) as Record<string, unknown>) };
  } catch (e) {
    return { configured: true, dashboardUrl: url, setupHint: `memory ${action} network error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Resolve the wallet scope: explicit input → Q402_AGENT_WALLET_ADDRESS env. */
export function resolveWalletId(inputWalletId?: string): string | undefined {
  const v = typeof inputWalletId === "string" && inputWalletId.length > 0 ? inputWalletId.toLowerCase() : CONFIG.walletId;
  return v || undefined;
}
