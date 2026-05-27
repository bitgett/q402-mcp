/**
 * q402_agentic_info — read-only Agent Wallet introspection.
 *
 * Surfaces the Agent Wallet that the configured Multichain API key
 * unlocks: the wallet address, the per-tx and daily spending caps, the
 * archive state, and an aggregate USD balance across the 9 EVM chains.
 *
 * Multi-wallet aware (Phase 3): each owner can hold up to 10 Agent
 * Wallets. Picks a wallet by:
 *   1. `walletId` tool input (explicit override)
 *   2. `Q402_AGENT_WALLET_ADDRESS` env (operator default)
 *   3. server-side default wallet (when nothing is specified)
 *
 * Useful for the AI to answer "what's in my agent wallet?" without the
 * user ever leaving the chat. Pairs naturally with `q402_pay` Mode C
 * where the agent has only the apiKey + (optionally) the walletId.
 *
 * Reads /api/wallet/agentic/info-by-key under the hood (apiKey-auth).
 */

import { z } from "zod";
import { CONFIG } from "../config.js";

export const AgenticInfoInputSchema = z.object({
  walletId: z
    .string()
    .optional()
    .describe(
      "Optional lowercased Agent Wallet address to introspect when the user " +
        "holds multiple (max 10 per owner). Omit to use Q402_AGENT_WALLET_ADDRESS env, " +
        "then the owner's default wallet.",
    ),
});
export type AgenticInfoInput = z.infer<typeof AgenticInfoInputSchema>;

export const AGENTIC_INFO_TOOL = {
  name: "q402_agentic_info",
  description:
    "Read-only Agent Wallet introspection. Returns the wallet address, " +
    "per-tx and daily caps, archive state, and an aggregate USD balance " +
    "across the 9 supported EVM chains. Authenticated by the configured " +
    "Multichain API key — no private key required. Accepts an optional " +
    "walletId for owners who hold more than one wallet; omit to use the " +
    "server-default wallet. Use this whenever the user asks 'what's in my " +
    "agent wallet?' or 'what's the spending limit?'",
  inputSchema: {
    type: "object" as const,
    properties: {
      walletId: {
        type: "string" as const,
        description:
          "Optional. Lowercased Agent Wallet address when the user holds " +
          "multiple wallets. Defaults to Q402_AGENT_WALLET_ADDRESS env, then the " +
          "owner's default wallet on the server.",
      },
    },
    additionalProperties: false,
  },
};

export interface AgenticInfoSummary {
  /** True when at least one auth source was usable to read the wallet. */
  configured: boolean;
  /** Wallet address, when known. */
  address: string | null;
  /** Lowercased wallet address used as the walletId throughout the API. */
  walletId: string | null;
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
  /** ERC-8004 public agent identity if registered. `{network}:{agentId}`. */
  erc8004AgentId: string | null;
  /** Direct link to the agent's 8004scan page when registered. */
  scan8004Url: string | null;
  /** Human-friendly explanation of what's missing or what to do next. */
  setupHint?: string;
  /** Echoes the dashboard URL so the AI can offer a clickable next step. */
  dashboardUrl: string;
}

interface WalletJson {
  /** Masked owner EOA from info-by-key (`0xAAAA…BBBB`). */
  ownerAddrShort: string;
  address: string;
  walletId?: string;
  createdAt: number;
  deletedAt: number | null;
  dailyLimitUsd: number | null;
  perTxMaxUsd: number | null;
  erc8004AgentId: string | null;
  label?: string | null;
}

/**
 * Build the 8004scan URL from a stored `{network}:{agentId}` tag.
 *
 * 8004scan uses chain-slug paths (`/agents/{slug}/{id}`), NOT the
 * EIP-155 CAIP-2 ID form. Verified against the live agents listing
 * at https://8004scan.io/agents. Kept in sync with `scanUrl()` in
 * the landing repo's `app/lib/erc8004.ts`.
 */
function scan8004UrlFor(tag: string | null): string | null {
  if (!tag) return null;
  const [network, agentId] = tag.split(":");
  if (!network || !agentId) return null;
  const slug =
    network === "bsc"          ? "bsc"
    : network === "bsc-testnet" ? "bsc-testnet"
    : network === "eth"        ? "ethereum"
    : network === "base"       ? "base"
    : network === "polygon"    ? "polygon"
    : network === "arbitrum"   ? "arbitrum"
    : network === "celo"       ? "celo"
    : null;
  if (slug === null) return null;
  return `https://8004scan.io/agents/${slug}/${agentId}`;
}

interface BalanceJson {
  asOf: number;
  totalUsd: number;
}

/**
 * Fetch the configured Agent Wallet's snapshot via apiKey auth. The
 * input.walletId overrides the env default; both are optional and a
 * missing pair falls through to the server-side default wallet for
 * the owner.
 */
export async function runAgenticInfo(input: AgenticInfoInput = {}): Promise<AgenticInfoSummary> {
  const base = CONFIG.relayBaseUrl;
  const dashboardUrl = base.replace(/\/api$/, "") + "/dashboard?tab=agent";

  // Resolution order: tool input → env → server default (= null body field).
  const explicitWalletId =
    typeof input.walletId === "string" && input.walletId.length > 0
      ? input.walletId.toLowerCase()
      : CONFIG.walletId;

  // No live key configured at all — full sandbox / first-install state.
  if (!CONFIG.apiKey || !CONFIG.apiKey.startsWith("q402_live_")) {
    return {
      configured: false,
      address: null,
      walletId: null,
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

  let wallet: WalletJson | null = null;
  let balance: BalanceJson | null = null;
  let fetchError: string | null = null;

  try {
    const res = await fetch(`${base}/wallet/agentic/info-by-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: CONFIG.apiKey,
        ...(explicitWalletId ? { walletId: explicitWalletId } : {}),
      }),
    });
    if (res.ok) {
      const data = (await res.json()) as { wallet?: WalletJson; balance?: BalanceJson };
      wallet = data.wallet ?? null;
      balance = data.balance ?? null;
    } else if (res.status === 404) {
      fetchError = "endpoint_not_deployed";
    } else if (res.status === 410) {
      fetchError = "wallet_archived";
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
      walletId: explicitWalletId,
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
          : fetchError === "wallet_archived"
            ? "The requested wallet is archived. Restore it from the dashboard before reading."
            : explicitWalletId
              ? `Could not fetch Agent Wallet ${explicitWalletId} for this apiKey. ` +
                "Verify the walletId is one of this owner's wallets, or omit it to read the default wallet."
              : "Could not fetch Agent Wallet for this apiKey. " +
                "Verify the key is bound to a wallet via the dashboard, then retry.",
    };
  }

  // Server returns wallet.walletId in Phase 3; fall back to lowercased
  // address for forward-compat with older servers.
  const resolvedWalletId =
    typeof wallet.walletId === "string" ? wallet.walletId : wallet.address.toLowerCase();

  return {
    configured: true,
    address: wallet.address,
    walletId: resolvedWalletId,
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
