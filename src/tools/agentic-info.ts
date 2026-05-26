/**
 * q402_agentic_info — read-only Agent Wallet introspection.
 *
 * Surfaces the Agent Wallet that the configured Multichain API key
 * unlocks: the wallet address, the per-tx and daily spending caps, the
 * archive state, and an aggregate USD balance across the 9 EVM chains.
 *
 * Useful for the AI to answer "what's in my agent wallet?" without the
 * user ever leaving the chat. Pairs naturally with `q402_pay` Mode C
 * (server-mediated) where the agent has only the apiKey — no private
 * key — and needs to know which address it's spending from.
 *
 * Reads two Q402 endpoints under the hood:
 *   GET /api/wallet/agentic         — wallet record (address, caps, deletedAt)
 *   GET /api/wallet/agentic/balance — Multicall3'd USDC + USDT per chain
 *
 * Both endpoints currently require owner-signed auth via EIP-191. Until
 * the apiKey-auth GET variant ships, this tool falls back to a "needs
 * dashboard sign-in" hint when only an apiKey is configured.
 */

import { z } from "zod";
import { CONFIG } from "../config.js";

export const AgenticInfoInputSchema = z.object({});
export type AgenticInfoInput = z.infer<typeof AgenticInfoInputSchema>;

export const AGENTIC_INFO_TOOL = {
  name: "q402_agentic_info",
  description:
    "Read-only Agent Wallet introspection. Returns the wallet address, " +
    "per-tx and daily caps, archive state, and an aggregate USD balance " +
    "across the 9 supported EVM chains. Authenticated by the configured " +
    "Multichain API key — no private key required. Use this whenever the " +
    "user asks 'what's in my agent wallet?' or 'what's the spending limit?'",
  inputSchema: {
    type: "object" as const,
    properties: {},
    additionalProperties: false,
  },
};

export interface AgenticInfoSummary {
  /** True when at least one auth source was usable to read the wallet. */
  configured: boolean;
  /** Wallet address, when known. */
  address: string | null;
  /** Daily and per-tx caps if the wallet has them set. */
  limits: {
    perTxMaxUsd: number | null;
    dailyLimitUsd: number | null;
  } | null;
  /** Soft-delete timestamp (ms epoch) if archived; null when active. */
  archivedAt: number | null;
  /** Aggregate USD balance across the 9 EVM chains (rounded to cents). */
  totalUsd: number | null;
  /** When balance was last read. */
  asOf: string | null;
  /** ERC-8004 public agent identity (if the owner graduated this wallet
   *  via the dashboard). Stored as `{network}:{agentId}` — e.g. "bsc:42".
   *  Null when not registered. */
  erc8004AgentId: string | null;
  /** Direct link to the agent's 8004scan page when registered. */
  scan8004Url: string | null;
  /** Human-friendly explanation of what's missing or what to do next. */
  setupHint?: string;
  /** Echoes the dashboard URL so the AI can offer a clickable next step. */
  dashboardUrl: string;
}

interface WalletJson {
  /** Masked owner EOA from info-by-key (`0xAAAA…BBBB` shape). The
   *  full owner address is intentionally not exposed on this surface
   *  — apiKey readers don't need it and exposing it widens the join
   *  surface on apiKey leaks. */
  ownerAddrShort: string;
  address: string;
  createdAt: number;
  deletedAt: number | null;
  dailyLimitUsd: number | null;
  perTxMaxUsd: number | null;
  erc8004AgentId: string | null;
}

/** Build the 8004scan URL from a stored `{network}:{agentId}` tag. */
function scan8004UrlFor(tag: string | null): string | null {
  if (!tag) return null;
  const [network, agentId] = tag.split(":");
  if (!network || !agentId) return null;
  const chainId =
    network === "bsc"
      ? 56
      : network === "eth"
        ? 1
        : network === "base"
          ? 8453
          : network === "polygon"
            ? 137
            : network === "arbitrum"
              ? 42161
              : network === "celo"
                ? 42220
                : null;
  if (chainId === null) return null;
  return `https://8004scan.io/eip155:${chainId}/agent/${agentId}`;
}

interface BalanceJson {
  asOf: number;
  totalUsd: number;
}

/**
 * Stub for the eventual apiKey-auth read path. Today the GET /api/wallet/
 * agentic and /balance endpoints require an EIP-191 owner signature, so
 * an MCP run that only has an apiKey can't fetch the wallet without
 * round-tripping to the dashboard. This tool surfaces that limitation
 * cleanly so the AI knows to direct the user to /dashboard rather than
 * grinding through a 401.
 */
export async function runAgenticInfo(): Promise<AgenticInfoSummary> {
  const base = CONFIG.relayBaseUrl;
  const dashboardUrl = base.replace(/\/api$/, "") + "/dashboard?tab=agent";

  // No live key configured at all — full sandbox / first-install state.
  if (!CONFIG.apiKey || !CONFIG.apiKey.startsWith("q402_live_")) {
    return {
      configured: false,
      address: null,
      limits: null,
      archivedAt: null,
      totalUsd: null,
      asOf: null,
      erc8004AgentId: null,
      scan8004Url: null,
      dashboardUrl,
      setupHint:
        "No live Q402 API key configured. Run q402_doctor to set one up, or " +
        "open your dashboard to create an Agent Wallet.",
    };
  }

  // The current Agent Wallet GET routes are owner-sig-only. Until the
  // apiKey-auth variant ships server-side, instruct the user to fetch
  // the address from the dashboard once and paste it into env via
  // Q402_AGENTIC_OWNER (future enhancement) or just visit the link.
  let wallet: WalletJson | null = null;
  let balance: BalanceJson | null = null;
  let fetchError: string | null = null;

  try {
    const res = await fetch(`${base}/wallet/agentic/info-by-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: CONFIG.apiKey }),
    });
    if (res.ok) {
      const data = (await res.json()) as { wallet?: WalletJson; balance?: BalanceJson };
      wallet = data.wallet ?? null;
      balance = data.balance ?? null;
    } else if (res.status === 404) {
      // Endpoint not deployed yet — fall through to dashboard hint.
      fetchError = "endpoint_not_deployed";
    } else {
      fetchError = `http_${res.status}`;
    }
  } catch (e) {
    fetchError = e instanceof Error ? e.message : String(e);
  }

  if (!wallet) {
    return {
      configured: true,
      address: null,
      limits: null,
      archivedAt: null,
      totalUsd: null,
      asOf: null,
      erc8004AgentId: null,
      scan8004Url: null,
      dashboardUrl,
      setupHint:
        fetchError === "endpoint_not_deployed"
          ? "Agent Wallet info-by-key endpoint is not live yet. " +
            "Open the dashboard to view your wallet directly."
          : "Could not fetch Agent Wallet for this apiKey. " +
            "Verify the key is bound to a wallet via the dashboard, then retry.",
    };
  }

  return {
    configured: true,
    address: wallet.address,
    limits: {
      perTxMaxUsd: wallet.perTxMaxUsd,
      dailyLimitUsd: wallet.dailyLimitUsd,
    },
    archivedAt: wallet.deletedAt,
    totalUsd: balance ? Math.round(balance.totalUsd * 100) / 100 : null,
    asOf: balance ? new Date(balance.asOf).toISOString() : null,
    erc8004AgentId: wallet.erc8004AgentId,
    scan8004Url: scan8004UrlFor(wallet.erc8004AgentId),
    dashboardUrl,
    setupHint: wallet.deletedAt
      ? "This Agent Wallet is archived and pending hard-delete. " +
        "Restore it from the dashboard before sending."
      : undefined,
  };
}
