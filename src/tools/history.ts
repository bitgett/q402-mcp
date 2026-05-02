/**
 * q402_history — read-only, requires an API key.
 *
 * Returns the most recent settled relays for the configured key, useful for
 * an agent to recap what was paid in this session ("did the 5 USDC go through?").
 */

import { z } from "zod";
import { CONFIG } from "../config.js";

export const HistoryInputSchema = z.object({
  limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe("How many recent transactions to return (default 10, max 50)."),
});
export type HistoryInput = z.infer<typeof HistoryInputSchema>;

export interface HistorySummary {
  apiKeyMasked: string | null;
  count: number;
  transactions: unknown[];
  setupHint?: string;
}

function mask(key: string | null): string | null {
  if (!key || key.length < 12) return null;
  return `${key.slice(0, 12)}…${key.slice(-4)}`;
}

export async function runHistory(input: HistoryInput): Promise<HistorySummary> {
  if (CONFIG.apiKeyKind === "missing") {
    return {
      apiKeyMasked: null,
      count: 0,
      transactions: [],
      setupHint:
        "Set Q402_API_KEY to a key issued at https://q402.quackai.ai/dashboard.",
    };
  }
  const limit = input.limit ?? 10;
  const url = `${CONFIG.relayBaseUrl}/transactions?apiKey=${encodeURIComponent(CONFIG.apiKey!)}&limit=${limit}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`/api/transactions failed: HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as { transactions?: unknown[] };
  const txs = Array.isArray(data.transactions) ? data.transactions : [];
  return {
    apiKeyMasked: mask(CONFIG.apiKey),
    count: txs.length,
    transactions: txs.slice(0, limit),
  };
}

export const HISTORY_TOOL = {
  name: "q402_history",
  description:
    "List the most recent relay transactions for the configured API key. " +
    "Read-only — useful for confirming a previous q402_pay actually settled.",
  inputSchema: {
    type: "object" as const,
    properties: {
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        description: "How many recent transactions to return (default 10).",
      },
    },
    additionalProperties: false,
  },
} as const;
