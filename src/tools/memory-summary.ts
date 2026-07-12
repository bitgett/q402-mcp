/**
 * q402_memory_summary - summarize the agent treasury's activity over a window.
 * Read-only; Mode-C, any live API key (free). Hits memory-by-key { action:"summary" }.
 */
import { z } from "zod";
import { callMemory, resolveWalletId } from "./memory-shared.js";

export const MemorySummaryInputSchema = z.object({
  walletId: z.string().optional().describe("Optional lowercased Agent Wallet address. Omit for the account default."),
  window: z.enum(["24h", "7d", "30d", "all"]).optional().describe("Time window: 24h | 7d | 30d | all. Default 7d."),
});
export type MemorySummaryInput = z.infer<typeof MemorySummaryInputSchema>;

export const MEMORY_SUMMARY_TOOL = {
  name: "q402_memory_summary",
  description:
    "Summarize the user's agent treasury activity over a window (24h / 7d / 30d / all): total USD spent, tx count, " +
    "spend broken down by chain and by source (send / recurring / redstone-trigger / yield / request / batch), the top " +
    "vendors paid, active scheduled payouts and the next fire time, open vs paid payment requests, open vs disputed " +
    "escrow, and the observable failures/holds (recurring rules that hit their cap or errored, disputed escrows). Use " +
    "for 'summarize my treasury', 'why did my balance drop yesterday' (window:24h), or 'what did we spend this week'. " +
    "Read-only and free: any live API key (Trial or Multichain).",
  inputSchema: {
    type: "object" as const,
    properties: {
      walletId: { type: "string" as const, description: "Optional lowercased Agent Wallet address." },
      window: { type: "string" as const, enum: ["24h", "7d", "30d", "all"], description: "Time window. Default 7d." },
    },
    additionalProperties: false,
  },
};

export async function runMemorySummary(input: MemorySummaryInput = {}): Promise<Record<string, unknown>> {
  const walletId = resolveWalletId(input.walletId);
  return callMemory("summary", { window: input.window ?? "7d", ...(walletId ? { walletId } : {}) });
}
