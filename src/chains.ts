/**
 * Static chain registry — mirrors q402-landing/public/q402-sdk.js v1.8.x.
 *
 * The authoritative source for these values is contracts.manifest.json on the
 * q402-landing repo; this MCP package keeps a frozen copy so it can be used
 * fully offline (Quote-only flow does not need any HTTP call).
 *
 * If any address, chainId, decimals, or domain name changes upstream, bump
 * this file *and* the @quackai/q402-mcp version in lock-step.
 *
 * Emergency BNB-only narrowing: `BNB_FOCUS_MODE` (defined below) is currently
 * false — the full 12-chain matrix is live. The flag stays in the module as a
 * one-line revert path in case we ever need to temporarily collapse the
 * supported set to BNB. Trial-key restrictions are enforced server-side
 * via TRIAL_BNB_ONLY (separate code path) and don't depend on this flag.
 */

export type ChainKey =
  | "avax"
  | "bnb"
  | "eth"
  | "xlayer"
  | "stable"
  | "mantle"
  | "injective"
  | "monad"
  | "scroll"
  | "arbitrum"
  | "base"
  | "robinhood";

export const CHAIN_KEYS: ReadonlyArray<ChainKey> = [
  "avax",
  "bnb",
  "eth",
  "xlayer",
  "stable",
  "mantle",
  "injective",
  "monad",
  "scroll",
  "arbitrum",
  "base",
  "robinhood",
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
  /** Optional on USDG-only chains (Robinhood Chain has neither Circle USDC nor
   *  Tether USDT — the on-chain tokens with those symbols are mock/scam). */
  usdc?: TokenInfo;
  usdt?: TokenInfo;
  /** Optional third token slot — currently only used by Ethereum (RLUSD). */
  rlusd?: TokenInfo;
  /** Optional fourth token slot — currently only used by BNB Chain (Q / QuackAI). */
  q?: TokenInfo;
  /** Optional token slot — currently only used by Robinhood Chain (USDG / Paxos Global Dollar). */
  usdg?: TokenInfo;
  /** When defined, payments are restricted to this whitelist. */
  supportedTokens?: ReadonlyArray<"USDC" | "USDT" | "RLUSD" | "Q" | "USDG">;
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
    // Q (QuackAI) — BNB-only, 18 dec. Gasless agentic send via the standard
    // bnb TransferAuthorization; the relay allowlists Q on bnb.
    q: { address: "0xc07e1300dc138601FA6B0b59f8D0FA477e690589", decimals: 18 },
    supportedTokens: ["USDC", "USDT", "Q"],
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
    implContract: "0xE5b90D564650bdcE7C2Bb4344F777f6582e05699",
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
    implContract: "0xa9a7dcE76DEF2AC36057FeF0d8103dF10581d61e",
    gasToken: "INJ",
    explorer: "https://blockscout.injective.network",
    // Native Circle USDC (CCTP) + canonical Tether (USDT0), both 6 dec.
    usdc: { address: "0xa00C59fF5a080D2b954d0c75e46E22a0c371235a", decimals: 6 },
    usdt: { address: "0x88f7F2b685F9692caf8c478f5BADF09eE9B1Cc13", decimals: 6 },
    supportedTokens: ["USDC", "USDT"],
    approxGasCostUsd: 0.004,
    note: "Native Circle USDC (CCTP) live since 2026-06; USDT0 also supported.",
  },
  monad: {
    key: "monad",
    name: "Monad",
    chainId: 143,
    domainName: "Q402 Monad",
    implContract: "0xc5d4dFA6D2e545409C1abf86f336Dd43bb87621f",
    gasToken: "MON",
    explorer: "https://monadscan.com",
    // Native Circle USDC via CCTP V2 (not bridged) + USDT0 (LayerZero OFT).
    usdc: { address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", decimals: 6 },
    usdt: { address: "0xe7cd86e13AC4309349F30B3435a9d337750fC82D", decimals: 6 },
    supportedTokens: ["USDC", "USDT"],
    approxGasCostUsd: 0.002,
  },
  scroll: {
    key: "scroll",
    name: "Scroll",
    chainId: 534352,
    domainName: "Q402 Scroll",
    implContract: "0x7635F32D893B64b5944CB8cbF2AC4cd3dA41B2f1",
    gasToken: "ETH",
    explorer: "https://scrollscan.com",
    // Native Circle USDC + canonical Tether on Scroll mainnet (addresses
    // confirmed with Scroll team during integration handshake).
    usdc: { address: "0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4", decimals: 6 },
    usdt: { address: "0xf55BEC9cafDbE8730f096Aa55dad6D22d44099Df", decimals: 6 },
    supportedTokens: ["USDC", "USDT"],
    approxGasCostUsd: 0.001,
    note: "zkEVM L2 — EIP-7702 live since the Euclid Phase 2 upgrade (2025-04-22). Data-availability cost dominates per-tx gas.",
  },
  arbitrum: {
    key: "arbitrum",
    name: "Arbitrum One",
    chainId: 42161,
    domainName: "Q402 Arbitrum",
    implContract: "0x8D854436ab0426F5BC6Cc70865C90576AD523E73",
    gasToken: "ETH",
    explorer: "https://arbiscan.io",
    // Native Circle USDC (CCTP) + canonical Tether on Arbitrum One.
    // The legacy bridged USDC.e (0xFF970A61...) is intentionally NOT supported.
    usdc: { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
    usdt: { address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6 },
    supportedTokens: ["USDC", "USDT"],
    approxGasCostUsd: 0.001,
    note: "Optimistic Rollup L2 — EIP-7702 live on Arbitrum One since ArbOS 40 'Callisto'; ArbOS 51 'Dia' (activated 2026-01-08) refined precompile delegation. Data-availability cost dominates per-tx gas.",
  },
  base: {
    key: "base",
    name: "Base",
    chainId: 8453,
    domainName: "Q402 Base",
    implContract: "0x2fb2B2D110b6c5664e701666B3741240242bf350",
    gasToken: "ETH",
    explorer: "https://basescan.org",
    // Native Circle USDC + bridged Tether USD on Base, both 6 decimals.
    usdc: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
    usdt: { address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6 },
    supportedTokens: ["USDC", "USDT"],
    approxGasCostUsd: 0.001,
    note: "OP Stack L2 — EIP-7702 live on Base mainnet via the Isthmus upgrade. Native Circle USDC; USDT is bridged. Data-availability cost dominates per-tx gas.",
  },
  robinhood: {
    key: "robinhood",
    name: "Robinhood Chain",
    chainId: 4663,
    domainName: "Q402 Robinhood Chain",
    implContract: "0x2fb2B2D110b6c5664e701666B3741240242bf350",
    gasToken: "ETH",
    explorer: "https://robinhoodchain.blockscout.com",
    // USDG (Paxos Global Dollar) is the ONLY token on Robinhood Chain, 6 dec.
    // There is NO Circle USDC and NO Tether USDT here — the on-chain tokens with
    // those symbols are mock/scam and are intentionally not supported.
    usdg: { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals: 6 },
    supportedTokens: ["USDG"],
    approxGasCostUsd: 0.001,
    note: "L2 — USDG (Paxos Global Dollar) is the only supported token; no Circle USDC or Tether USDT on this chain.",
  },
};

// ─── BNB-only emergency flag (mirrors q402-landing app/lib/feature-flags.ts) ──
// Currently false: the full 12-chain matrix is live. The flag exists as a
// one-line revert path — flipping to true rewrites `supportedTokens` for
// every non-BNB chain to [] at module load, which makes every non-BNB
// quote/pay call produce a single deterministic rejection message. The
// landing repo's BNB_FOCUS_MODE must track this value; tests pin the
// match.
export const BNB_FOCUS_MODE = false;
export const BNB_FOCUS_REJECTION_MESSAGE =
  "BNB-only mode active: this chain/token is temporarily hidden. " +
  "Full multi-chain support is the normal state. " +
  'Pass chain: "bnb" with token "USDC" or "USDT".';

if (BNB_FOCUS_MODE) {
  for (const key of CHAIN_KEYS) {
    if (key !== "bnb") {
      (CHAIN_CONFIG[key] as { supportedTokens: ReadonlyArray<"USDC" | "USDT" | "RLUSD" | "Q" | "USDG"> }).supportedTokens = [];
    }
  }
}

export function getChain(key: ChainKey): ChainConfig {
  const cfg = CHAIN_CONFIG[key];
  if (!cfg) throw new Error(`Unsupported chain: ${key}. Supported: ${CHAIN_KEYS.join(", ")}`);
  return cfg;
}

export function tokenFor(cfg: ChainConfig, token: "USDC" | "USDT" | "RLUSD" | "Q" | "USDG"): TokenInfo {
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
  if (token === "Q") {
    if (!cfg.q) {
      throw new Error(
        `Q (QuackAI) is not supported on ${cfg.name} (key=${cfg.key}). ` +
          `Q is currently BNB-only.`,
      );
    }
    return cfg.q;
  }
  if (token === "USDG") {
    if (!cfg.usdg) {
      throw new Error(
        `USDG (Paxos Global Dollar) is not supported on ${cfg.name} (key=${cfg.key}). ` +
          `USDG is currently Robinhood-Chain-only.`,
      );
    }
    return cfg.usdg;
  }
  const t = token === "USDC" ? cfg.usdc : cfg.usdt;
  if (!t) {
    throw new Error(
      `${token} is not supported on ${cfg.name} (key=${cfg.key}). ` +
        `Supported tokens: ${cfg.supportedTokens?.join(", ") ?? "none"}.`,
    );
  }
  return t;
}
