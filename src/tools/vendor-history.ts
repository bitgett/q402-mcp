/**
 * q402_vendor_history — how much has been paid to a vendor, or a vendor
 * leaderboard. Read-only; Mode-C. Hits memory-by-key { action:"vendor" }.
 */
import { z } from "zod";
import { callMemory, resolveWalletId } from "./memory-shared.js";

export const VendorHistoryInputSchema = z.object({
  vendor: z.string().optional().describe("Vendor wallet address (0x…). Omit to get a leaderboard of all vendors by total paid."),
  walletId: z.string().optional().describe("Optional lowercased Agent Wallet address. Omit for the account default."),
  window: z.enum(["24h", "7d", "30d", "all"]).optional().describe("Time window: 24h | 7d | 30d | all. Default all."),
});
export type VendorHistoryInput = z.infer<typeof VendorHistoryInputSchema>;

export const VENDOR_HISTORY_TOOL = {
  name: "q402_vendor_history",
  description:
    "Vendor payment history. With a `vendor` address: total USD paid, tx count, first/last paid, and the recurring " +
    "cadence if the vendor is on a schedule (answers 'how much have we paid Alice so far?'). Without `vendor`: a " +
    "leaderboard of all vendors by total paid, each flagged whether it is paid on a monthly schedule (answers 'which " +
    "vendors get paid every month?'). Vendors are address-based; a human name only appears if it was saved as a rule " +
    "label. Read-only; Multichain API key.",
  inputSchema: {
    type: "object" as const,
    properties: {
      vendor: { type: "string" as const, description: "Vendor wallet address (0x…). Omit for the leaderboard." },
      walletId: { type: "string" as const, description: "Optional lowercased Agent Wallet address." },
      window: { type: "string" as const, enum: ["24h", "7d", "30d", "all"], description: "Time window. Default all." },
    },
    additionalProperties: false,
  },
};

export async function runVendorHistory(input: VendorHistoryInput = {}): Promise<Record<string, unknown>> {
  const walletId = resolveWalletId(input.walletId);
  return callMemory("vendor", {
    window: input.window ?? "all",
    ...(input.vendor ? { vendor: input.vendor } : {}),
    ...(walletId ? { walletId } : {}),
  });
}
