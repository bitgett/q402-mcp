/**
 * q402_pay — sandbox-default, with three layered guards before any real TX:
 *   1. Per-call max-amount (Q402_MAX_AMOUNT_PER_CALL, default $5)
 *   2. Recipient allowlist (Q402_ALLOWED_RECIPIENTS, optional)
 *   3. Live mode requires:
 *        - the resolved scope key (Q402_TRIAL_API_KEY for BNB-auto-routed
 *          calls, Q402_MULTICHAIN_API_KEY for everything else, or the legacy
 *          Q402_API_KEY single-env fallback) to be q402_live_*
 *        - Q402_PRIVATE_KEY set
 *        - Q402_ENABLE_REAL_PAYMENTS=1
 *      Any miss → sandbox response with a `setupHint` explaining which env
 *      is missing.
 *
 * The MCP tool description tells the model to ALWAYS get explicit user
 * confirmation before invoking; that is the fourth (procedural) guard.
 */

import { isAddress } from "ethers";
import { z } from "zod";
import { CHAIN_KEYS, getChain, tokenFor } from "../chains.js";
import { CONFIG, resolveApiKey, isLiveModeFor, type KeyScopeRequest } from "../config.js";
import { Q402NodeClient, sandboxPay, type PayResult } from "../client.js";

export const PayInputSchema = z.object({
  chain: z.enum(["avax", "bnb", "eth", "xlayer", "stable", "mantle", "injective", "monad", "scroll"]),
  to: z
    .string()
    .refine(isAddress, "to must be a valid 0x-prefixed EVM address")
    .describe("Recipient EVM address (0x + 40 hex)."),
  amount: z
    .string()
    .regex(/^\d+(\.\d+)?$/, "amount must be a positive decimal string")
    .describe('Human-readable decimal amount, e.g. "5.00".'),
  token: z.enum(["USDC", "USDT", "RLUSD"]).describe(
    'Stablecoin symbol. USDC / USDT supported on most chains (Injective is USDT-only). ' +
      'RLUSD (Ripple USD, NY DFS regulated, decimals 18) is Ethereum-only.',
  ),
  keyScope: z
    .enum(["auto", "trial", "multichain"])
    .optional()
    .describe(
      'Which API key to use. "auto" (default): chain="bnb" + ' +
        'Q402_TRIAL_API_KEY set → Trial (free sponsored); else Multichain. ' +
        '"trial" forces the BNB-only sponsored key. "multichain" forces ' +
        'the paid 9-chain key. Same rule applies to q402_batch_pay.',
    ),
  confirm: z
    .literal(true)
    .describe(
      "MUST be true. Prove the user explicitly approved this exact recipient and amount " +
        "in the conversation right before this tool was called. Setting this to true on " +
        "behalf of the user without confirmation is a violation of the tool contract.",
    ),
});

export type PayInput = z.infer<typeof PayInputSchema>;

export interface PaySummary {
  result: PayResult;
  guardsApplied: string[];
  setupHint?: string;
}

function maxAmountGuard(amount: string, cap: number): void {
  // amount comes pre-validated as `\d+(\.\d+)?` — Number() is safe here for
  // a comparison against the per-call USD cap (the cap is intentionally a
  // small UI-friendly value, so float precision is irrelevant for the check).
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) {
    throw new Error(`unparseable amount "${amount}"`);
  }
  if (numeric > cap) {
    throw new Error(
      `amount $${amount} exceeds the per-call cap of $${cap}. ` +
        `Set Q402_MAX_AMOUNT_PER_CALL to a higher value if intentional.`,
    );
  }
}

function recipientGuard(to: string, allow: string[]): void {
  if (allow.length === 0) return;
  if (!allow.includes(to.toLowerCase())) {
    throw new Error(
      `recipient ${to} is not in Q402_ALLOWED_RECIPIENTS. ` +
        "Either add this address to the allowlist or unset the env var to disable the guard.",
    );
  }
}

export async function runPay(input: PayInput): Promise<PaySummary> {
  const chain = getChain(input.chain);
  // Surface the chain-level token gate (Injective USDT-only) early.
  tokenFor(chain, input.token);
  if (chain.supportedTokens && !chain.supportedTokens.includes(input.token)) {
    throw new Error(
      `token ${input.token} is not supported on chain ${chain.key}. ` +
        `Supported on this chain: ${chain.supportedTokens.join(", ")}.`,
    );
  }

  const guardsApplied: string[] = [];

  maxAmountGuard(input.amount, CONFIG.maxAmountPerCallUsd);
  guardsApplied.push(`max_amount<=${CONFIG.maxAmountPerCallUsd}`);

  recipientGuard(input.to, CONFIG.allowedRecipients);
  if (CONFIG.allowedRecipients.length > 0) {
    guardsApplied.push(`recipient_allowlist[${CONFIG.allowedRecipients.length}]`);
  }

  // Two-key resolution. Sandbox-default: never throws. When a scope can't be
  // resolved to a live key (env missing, impossible chain×scope combo, …) the
  // resolver returns `apiKey: null` plus a `sandboxReason` hint that we
  // surface as the agent-visible setupHint. Unified rule with q402_batch_pay:
  // BNB + Trial key set ⇒ Trial; else Multichain.
  const scopeRequest: KeyScopeRequest = input.keyScope ?? "auto";
  const resolved = resolveApiKey(input.chain, scopeRequest);
  guardsApplied.push(`scope=${resolved.scope}${resolved.fromLegacyFallback ? "(legacy)" : ""}`);

  const live = isLiveModeFor(resolved);
  if (!live) {
    const result = sandboxPay(chain, {
      to: input.to,
      amount: input.amount,
      token: input.token,
    });
    guardsApplied.push("mode=sandbox");
    // Prefer the resolver's specific reason (e.g. "trial+monad impossible")
    // over the generic missing-env message. Falls back to the generic when
    // the resolver returned a key but live mode failed on its own gates.
    const setupHint =
      resolved.sandboxReason ?? describeSandboxReason(resolved.apiKey ?? "");
    return { result, guardsApplied, setupHint };
  }

  const client = new Q402NodeClient({
    apiKey: resolved.apiKey!,
    privateKey: CONFIG.privateKey!,
    chain,
    relayBaseUrl: CONFIG.relayBaseUrl,
  });
  const result = await client.pay({
    to: input.to,
    amount: input.amount,
    token: input.token,
  });
  guardsApplied.push("mode=live");
  return { result, guardsApplied };
}

function describeSandboxReason(resolvedKey: string): string {
  const missing: string[] = [];
  if (!resolvedKey.startsWith("q402_live_")) missing.push("a live API key (must start with q402_live_)");
  if (!CONFIG.privateKey) missing.push("Q402_PRIVATE_KEY");
  if (!CONFIG.realPaymentsRequested) missing.push("Q402_ENABLE_REAL_PAYMENTS=1");
  if (missing.length === 0) return "Sandbox mode active (no env state change needed).";
  return (
    "Sandbox mode is active because the following env vars are missing or not yet set: " +
    missing.join(", ") +
    ". Get a live API key at https://q402.quackai.ai/dashboard."
  );
}

export const PAY_TOOL = {
  name: "q402_pay",
  description:
    "Send a gasless USDC, USDT, or RLUSD payment via Q402. " +
    "Auto-routing: chain='bnb' + Q402_TRIAL_API_KEY set → Trial (free sponsored); " +
    "anything else → Multichain (paid 9-chain). Same rule for q402_batch_pay. " +
    "Set keyScope='trial' or 'multichain' to force one explicitly. " +
    "Trial keys reject any non-BNB chain server-side with TRIAL_BNB_ONLY. " +
    "Multichain keys cover avax, bnb, eth, xlayer, stable, mantle, injective, monad, scroll — " +
    "USDC/USDT on most chains, RLUSD on Ethereum only, Injective USDT-only. " +
    "SANDBOX BY DEFAULT — no funds move unless the resolved key is a live key " +
    "(q402_live_*), Q402_PRIVATE_KEY is set, and Q402_ENABLE_REAL_PAYMENTS=1. " +
    "The recipient receives the full amount; the sender pays $0 in gas. " +
    "Note: the first q402_pay on a chain creates a persistent EIP-7702 " +
    "delegation on the sender's EOA (set-code TX, Pectra). Subsequent " +
    "payments on the same chain reuse it (gas-efficient). To remove the " +
    "delegation later, call q402_clear_delegation. " +
    "ALWAYS get explicit user confirmation of the exact recipient address, " +
    "amount, chain, and token in conversation immediately before calling " +
    "this tool.",
  inputSchema: {
    type: "object" as const,
    properties: {
      chain: {
        type: "string",
        enum: CHAIN_KEYS as readonly string[],
        description: "Target chain.",
      },
      to: {
        type: "string",
        description: "Recipient EVM address (0x + 40 hex).",
      },
      amount: {
        type: "string",
        description: 'Human-readable decimal amount, e.g. "5.00".',
      },
      token: {
        type: "string",
        enum: ["USDC", "USDT", "RLUSD"],
        description:
          "Stablecoin to send. USDC / USDT supported on most chains; Injective is USDT-only. " +
          "RLUSD (Ripple USD, NY DFS regulated, decimals 18) is Ethereum-only.",
      },
      keyScope: {
        type: "string",
        enum: ["auto", "trial", "multichain"],
        description:
          'Which API key to use. "auto" (default) picks Trial for BNB when ' +
          'Q402_TRIAL_API_KEY is set, Multichain otherwise. "trial" forces the ' +
          'BNB-only sponsored key. "multichain" forces the paid 9-chain key.',
      },
      confirm: {
        type: "boolean",
        const: true,
        description:
          "MUST be true and only set after the user has confirmed recipient + amount in chat.",
      },
    },
    required: ["chain", "to", "amount", "token", "confirm"],
    additionalProperties: false,
  },
} as const;
