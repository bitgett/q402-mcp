/**
 * q402_quote — read-only, no API key required.
 *
 * Compares gas costs across the eight chains Q402 relays for, given a payment
 * amount and (optional) target chain/token. Lets a Claude agent reason about
 * "where should I send this?" before any signing happens.
 */

import { z } from "zod";
import { CHAIN_CONFIG, CHAIN_KEYS, type ChainConfig, type ChainKey } from "../chains.js";

export const QuoteInputSchema = z.object({
  amount: z
    .string()
    .regex(/^\d+(\.\d+)?$/, "amount must be a positive decimal string like \"5.00\"")
    .describe("Human-readable decimal amount the user intends to send (e.g. \"5\", \"50.00\")."),
  token: z
    .enum(["USDC", "USDT", "RLUSD"])
    .optional()
    .describe(
      "Optional token filter. USDC / USDT are supported on most chains; RLUSD " +
        "(Ripple USD, NY DFS regulated, decimals 18) is Ethereum-only — passing " +
        "RLUSD here narrows the quote to chain=\"eth\".",
    ),
  chain: z
    .enum(["avax", "bnb", "eth", "xlayer", "stable", "mantle", "injective", "monad"])
    .optional()
    .describe(
      "Optional chain filter. When omitted, all 8 chains are compared and ranked by gas cost.",
    ),
});

export type QuoteInput = z.infer<typeof QuoteInputSchema>;

interface ChainQuote {
  chain: ChainKey;
  name: string;
  chainId: number;
  gasToken: string;
  approxGasCostUsd: number;
  supportedTokens: ReadonlyArray<"USDC" | "USDT" | "RLUSD">;
  gasTokenForReceiver: "0 (gasless)";
  note?: string;
}

function quoteForChain(cfg: ChainConfig): ChainQuote {
  const supported: ReadonlyArray<"USDC" | "USDT" | "RLUSD"> = cfg.supportedTokens ?? ["USDC", "USDT"];
  return {
    chain: cfg.key,
    name: cfg.name,
    chainId: cfg.chainId,
    gasToken: cfg.gasToken,
    approxGasCostUsd: cfg.approxGasCostUsd,
    supportedTokens: supported,
    gasTokenForReceiver: "0 (gasless)",
    ...(cfg.note ? { note: cfg.note } : {}),
  };
}

export function runQuote(input: QuoteInput): {
  amount: string;
  recommendedChain: ChainKey;
  quotes: ChainQuote[];
  disclaimer: string;
} {
  const filterChain = input.chain;
  const filterToken = input.token;

  const candidates = (filterChain ? [filterChain] : CHAIN_KEYS)
    .map(k => CHAIN_CONFIG[k])
    .filter(cfg => {
      // Skip chains narrowed to an empty supportedTokens list — happens when
      // BNB_FOCUS_MODE (emergency flag, currently false) mutates non-BNB
      // chains to []. Without this guard the quote tool would happily list
      // "Ethereum: no tokens", which is a worse signal to the model than
      // just omitting the chain entirely.
      if (cfg.supportedTokens && cfg.supportedTokens.length === 0) return false;
      if (!filterToken) return true;
      if (cfg.supportedTokens && !cfg.supportedTokens.includes(filterToken)) return false;
      return true;
    });

  if (candidates.length === 0) {
    throw new Error(
      `No chain in the registry supports token ${filterToken}. ` +
        "Try omitting the token filter to see all options.",
    );
  }

  const quotes = candidates.map(quoteForChain).sort((a, b) => a.approxGasCostUsd - b.approxGasCostUsd);
  const cheapest = quotes[0]!;

  return {
    amount: input.amount,
    recommendedChain: cheapest.chain,
    quotes,
    disclaimer:
      "Gas cost is order-of-magnitude only. Real cost depends on network congestion at relay time. " +
      "Q402 always charges $0 to the payer's wallet — gas is paid from the developer's pre-funded gas tank.",
  };
}

export const QUOTE_TOOL = {
  name: "q402_quote",
  description:
    "Compare gas costs and supported tokens across the 8 chains Q402 relays " +
    "for (avax, bnb, eth, xlayer, stable, mantle, injective, monad). " +
    "Returns the full chain × token matrix unconditionally — this tool does " +
    "not read any API key, so it can't filter by trial vs multichain scope. " +
    "When the caller intends to settle with a Trial API Key, treat any non-BNB " +
    "row as informational only (q402_pay will return 403 TRIAL_BNB_ONLY for " +
    "those). Includes RLUSD on Ethereum and Injective USDT-only. Read-only — " +
    "no API key needed, no funds move. Use this before q402_pay so the user " +
    "can see what's available and pick a chain.",
  // Plain JSON schema mirroring the Zod schema above; MCP servers receive parameters as JSON.
  inputSchema: {
    type: "object" as const,
    properties: {
      amount: {
        type: "string",
        description: 'Human-readable decimal amount, e.g. "5" or "50.00".',
      },
      token: {
        type: "string",
        enum: ["USDC", "USDT", "RLUSD"],
        description:
          "Optional token filter. RLUSD (Ripple USD) is Ethereum-only — passing it narrows the quote to chain=\"eth\".",
      },
      chain: {
        type: "string",
        enum: CHAIN_KEYS as readonly string[],
        description: "Optional chain filter; omit to compare all 8.",
      },
    },
    required: ["amount"],
    additionalProperties: false,
  },
} as const;
