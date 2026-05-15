/**
 * Static chain registry — mirrors q402-landing/public/q402-sdk.js v1.7.x.
 *
 * The authoritative source for these values is contracts.manifest.json on the
 * q402-landing repo; this MCP package keeps a frozen copy so it can be used
 * fully offline (Quote-only flow does not need any HTTP call).
 *
 * If any address, chainId, decimals, or domain name changes upstream, bump
 * this file *and* the @quackai/q402-mcp version in lock-step.
 *
 * ── BNB-focus sprint (2026-05-19 → 2026-06-30) ───────────────────────────────
 * While BNB_FOCUS_MODE is true (see below), `supportedTokens` for every chain
 * other than BNB is rewritten to [] at module load. The chain entries are
 * intentionally retained verbatim so quote and pay calls produce a single
 * sprint-aware rejection message, and the original 7-chain matrix is one
 * boolean flip away.
 */

export type ChainKey =
  | "avax"
  | "bnb"
  | "eth"
  | "xlayer"
  | "stable"
  | "mantle"
  | "injective";

export const CHAIN_KEYS: ReadonlyArray<ChainKey> = [
  "avax",
  "bnb",
  "eth",
  "xlayer",
  "stable",
  "mantle",
  "injective",
];

export interface TokenInfo {
  address: string;
  decimals: number;
}

export interface ChainConfig {
  key: ChainKey;
  name: string;
  chainId: number;
  domainName: string;
  implContract: string;
  /** Native gas token symbol — what the gas tank must be funded with. */
  gasToken: string;
  /** Block explorer base URL for tx links. */
  explorer: string;
  usdc: TokenInfo;
  usdt: TokenInfo;
  /** Optional third token slot — currently only used by Ethereum (RLUSD). */
  rlusd?: TokenInfo;
  /** When defined, payments are restricted to this whitelist. */
  supportedTokens?: ReadonlyArray<"USDC" | "USDT" | "RLUSD">;
  /** Approximate per-tx gas cost in USD — order-of-magnitude only, used by quote tool. */
  approxGasCostUsd: number;
  /** Optional human note surfaced by the quote tool. */
  note?: string;
}

export const CHAIN_CONFIG: Record<ChainKey, ChainConfig> = {
  avax: {
    key: "avax",
    name: "Avalanche C-Chain",
    chainId: 43114,
    domainName: "Q402 Avalanche",
    implContract: "0x96a8C74d95A35D0c14Ec60364c78ba6De99E9A4c",
    gasToken: "AVAX",
    explorer: "https://snowtrace.io",
    usdc: { address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6 },
    usdt: { address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", decimals: 6 },
    supportedTokens: ["USDC", "USDT"],
    approxGasCostUsd: 0.003,
  },
  bnb: {
    key: "bnb",
    name: "BNB Chain",
    chainId: 56,
    domainName: "Q402 BNB Chain",
    implContract: "0x6cF4aD62C208b6494a55a1494D497713ba013dFa",
    gasToken: "BNB",
    explorer: "https://bscscan.com",
    usdc: { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 },
    usdt: { address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
    supportedTokens: ["USDC", "USDT"],
    approxGasCostUsd: 0.001,
  },
  eth: {
    key: "eth",
    name: "Ethereum Mainnet",
    chainId: 1,
    domainName: "Q402 Ethereum",
    implContract: "0x8E67a64989CFcb0C40556b13ea302709CCFD6AaD",
    gasToken: "ETH",
    explorer: "https://etherscan.io",
    usdc:  { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
    usdt:  { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
    // Ripple USD (RLUSD) — NY DFS regulated, decimals 18, UUPS proxy.
    // Ethereum-only; other chains' supportedTokens omits RLUSD.
    rlusd: { address: "0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD", decimals: 18 },
    supportedTokens: ["USDC", "USDT", "RLUSD"],
    approxGasCostUsd: 1.2,
    note: "L1 — gas is volatile; quote is a snapshot, expect 5–10x swings during congestion. RLUSD supported here only.",
  },
  xlayer: {
    key: "xlayer",
    name: "X Layer",
    chainId: 196,
    domainName: "Q402 X Layer",
    implContract: "0x8D854436ab0426F5BC6Cc70865C90576AD523E73",
    gasToken: "OKB",
    explorer: "https://www.oklink.com/xlayer",
    usdc: { address: "0x74b7F16337b8972027F6196A17a631aC6dE26d22", decimals: 6 },
    usdt: { address: "0x1E4a5963aBFD975d8c9021ce480b42188849D41D", decimals: 6 },
    supportedTokens: ["USDC", "USDT"],
    approxGasCostUsd: 0.002,
  },
  stable: {
    key: "stable",
    name: "Stable Chain",
    chainId: 988,
    domainName: "Q402 Stable",
    implContract: "0x2fb2B2D110b6c5664e701666B3741240242bf350",
    gasToken: "USDT0",
    explorer: "https://stable-explorer.io",
    // USDT0 (the only token on Stable) — both USDC and USDT API tokens resolve here.
    usdc: { address: "0x779ded0c9e1022225f8e0630b35a9b54be713736", decimals: 18 },
    usdt: { address: "0x779ded0c9e1022225f8e0630b35a9b54be713736", decimals: 18 },
    supportedTokens: ["USDC", "USDT"],
    approxGasCostUsd: 0.0005,
    note: "Gas is paid in USDT0; both USDC and USDT API inputs alias to USDT0.",
  },
  mantle: {
    key: "mantle",
    name: "Mantle",
    chainId: 5000,
    domainName: "Q402 Mantle",
    implContract: "0x2fb2B2D110b6c5664e701666B3741240242bf350",
    gasToken: "MNT",
    explorer: "https://mantlescan.xyz",
    usdc: { address: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9", decimals: 6 },
    // USDT0 (LayerZero OFT) — Mantle ecosystem default since the 2025-11-27 migration.
    usdt: { address: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736", decimals: 6 },
    supportedTokens: ["USDC", "USDT"],
    approxGasCostUsd: 0.002,
  },
  injective: {
    key: "injective",
    name: "Injective EVM",
    chainId: 1776,
    domainName: "Q402 Injective",
    implContract: "0x2fb2B2D110b6c5664e701666B3741240242bf350",
    gasToken: "INJ",
    explorer: "https://blockscout.injective.network",
    // Mirror entry for the registry shape — both API tokens point at the same USDT.
    // q402_pay rejects token: "USDC" with chain: "injective" upfront via supportedTokens.
    usdc: { address: "0x88f7F2b685F9692caf8c478f5BADF09eE9B1Cc13", decimals: 6 },
    usdt: { address: "0x88f7F2b685F9692caf8c478f5BADF09eE9B1Cc13", decimals: 6 },
    supportedTokens: ["USDT"],
    approxGasCostUsd: 0.004,
    note: "USDT only until Circle CCTP native USDC ships (announced for Q2 2026).",
  },
};

// ─── BNB-focus sprint flag (mirrors q402-landing app/lib/feature-flags.ts) ────
// These two flags MUST track each other or server and SDK will disagree on
// which calls to accept. The post-config narrowing loop below is what
// actually enforces the gate; flip BNB_FOCUS_MODE to false to restore the
// original 7-chain `supportedTokens` lists verbatim.
export const BNB_FOCUS_MODE = false;
export const BNB_FOCUS_REJECTION_MESSAGE =
  "BNB-focus sprint: this chain/token is temporarily hidden. " +
  "Full multi-chain support returns after the sprint window. " +
  'Pass chain: "bnb" with token "USDC" or "USDT".';

if (BNB_FOCUS_MODE) {
  for (const key of CHAIN_KEYS) {
    if (key !== "bnb") {
      (CHAIN_CONFIG[key] as { supportedTokens: ReadonlyArray<"USDC" | "USDT" | "RLUSD"> }).supportedTokens = [];
    }
  }
}

export function getChain(key: ChainKey): ChainConfig {
  const cfg = CHAIN_CONFIG[key];
  if (!cfg) throw new Error(`Unsupported chain: ${key}. Supported: ${CHAIN_KEYS.join(", ")}`);
  return cfg;
}

export function tokenFor(cfg: ChainConfig, token: "USDC" | "USDT" | "RLUSD"): TokenInfo {
  if (BNB_FOCUS_MODE && !(cfg.supportedTokens?.includes(token) ?? false)) {
    throw new Error(BNB_FOCUS_REJECTION_MESSAGE);
  }
  if (token === "RLUSD") {
    if (!cfg.rlusd) {
      throw new Error(
        `RLUSD is not supported on ${cfg.name} (key=${cfg.key}). ` +
          `RLUSD is currently Ethereum-only.`,
      );
    }
    return cfg.rlusd;
  }
  return token === "USDC" ? cfg.usdc : cfg.usdt;
}
