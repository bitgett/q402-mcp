/**
 * q402_bridge_send - execute a CCIP USDC bridge.
 *
 * Mode C (server-managed Agentic Wallet): Q402 server holds the Agent
 * Wallet's encrypted PK and signs ccipSend on the user's behalf. The
 * MCP client only needs a live Multichain API key - the bridge route
 * authenticates via API key instead of an owner EIP-712 signature.
 *
 * Sandbox-by-default. Live execution requires:
 *   1. `sandbox: false` on the call
 *   2. `Q402_ENABLE_REAL_PAYMENTS=1` env (default 1 since 0.5.11 but
 *      respected if explicitly set to 0)
 *   3. `Q402_MULTICHAIN_API_KEY=q402_live_…` (or `Q402_API_KEY` legacy)
 *
 * Prerequisites for the live path:
 *   - Multichain subscription active for the API key's owner
 *   - Agent Wallet has USDC on the source chain
 *   - Gas Tank has LINK (or native, per feeToken) on the source chain
 *     to cover the CCIP fee + auto-fund the Agent Wallet's
 *     source-chain gas
 *   - Agent Wallet is NOT EIP-7702 delegated to Q402 impl on the
 *     source chain (delegation blocks native auto-fund; clear it first -
 *     server-managed Mode C uses the dashboard Clear-delegation button,
 *     local-key modes A/B use the q402_clear_delegation tool)
 */

import { z } from "zod";
import { CONFIG, resolveApiKey } from "../config.js";
import { checkConsent } from "../consent.js";

export const BridgeSendInputSchema = z.object({
  src: z.enum(["eth", "avax", "arbitrum"]).describe("Source chain"),
  dst: z.enum(["eth", "avax", "arbitrum"]).describe("Destination chain"),
  // `^\d+$` accepts "0" which is a no-op bridge. Require at least one
  // non-zero digit so an accidental amount=0 fails locally instead of
  // returning a synthetic "success" envelope in sandbox.
  amount: z.string().regex(/^\d*[1-9]\d*$/).describe("USDC amount in raw 6-decimal units, > 0"),
  walletId: z.string().optional().describe("Agentic Wallet ID (from q402_agentic_info). Optional - defaults to the owner's default Agent Wallet."),
  feeToken: z.enum(["LINK", "native"]).optional().describe("Fee token. Defaults to LINK (~10% cheaper than native)."),
  sandbox: z.boolean().optional().describe("Sandbox mode (default true). Set to false for a live on-chain bridge."),
  maxFeeRaw: z.string().regex(/^\d+$/).optional().describe("Optional client-side fee cap in raw 18-dec wei. Server still clamps to its 10% slippage ceiling; clients may LOWER but not RAISE."),
  confirm: z
    .boolean()
    .optional()
    .describe(
      "MUST be true to fire a LIVE bridge (ignored in sandbox). Set this only after the " +
        "user has explicitly approved this exact bridge (src, dst, amount, feeToken) in the " +
        "conversation. When omitted or false on a live call the tool previews the action and " +
        "does NOT move any funds. Never set confirm:true on the user's behalf without approval.",
    ),
  consentToken: z
    .string()
    .optional()
    .describe(
      "Two-phase consent. LEAVE UNSET on the first live call: the tool previews " +
        "the bridge (without moving funds) and returns a `consentToken`. Relay the " +
        "preview to the user, get an explicit yes, then re-call with sandbox:false, " +
        "confirm:true, AND this consentToken. The tool re-derives it from the bridge " +
        "it is about to execute (src, dst, amount, feeToken) and refuses on mismatch.",
    ),
}).refine(d => d.src !== d.dst, {
  // Local Zod rejection saves a network round-trip + a Q402 backend log
  // entry. The bridge route also rejects same-chain bridges but the
  // agent only finds out after burning a request.
  message: "src must differ from dst",
  path: ["dst"],
});

export const BRIDGE_SEND_TOOL = {
  name: "q402_bridge_send",
  description:
    "Execute a Chainlink CCIP USDC bridge across the 3-chain triangle (eth/avax/arbitrum) on " +
    "behalf of the user's server-managed Agentic Wallet (Mode C). Sandbox-by-default - returns a " +
    "synthetic messageId unless `sandbox: false` is passed AND Q402_ENABLE_REAL_PAYMENTS=1 AND a " +
    "live Multichain API key is configured. The server signs ccipSend with the Agent Wallet's " +
    "encrypted PK, auto-funds source-chain gas from the user's Gas Tank, and debits both the auto- " +
    "fund cost and the CCIP fee per the bridge's settled receipt. " +
    "TWO-PHASE CONSENT - a LIVE bridge (sandbox: false) refuses to execute unless BOTH confirm: true " +
    "AND a matching consentToken are set. Call it first WITHOUT consentToken to get a preview (src, " +
    "dst, amount, fee token) plus a consentToken; show that to the user, get explicit approval, THEN " +
    "re-call with sandbox: false, confirm: true, AND that consentToken. The token is re-derived from " +
    "the bridge about to run, so the previewed bridge can't be swapped. Never fabricate a token. " +
    "Recommended flow: q402_bridge_quote first → preview + confirm cost with the user → " +
    "q402_bridge_send with sandbox: false, confirm: true, consentToken. Live mode needs a " +
    "Multichain subscription; trial keys are rejected. If the bridge returns AGENT_WALLET_DELEGATED, " +
    "clear the delegation first: server-managed Agent Wallets (Mode C / API key) use the Clear " +
    "delegation button on the dashboard; local-key modes (Q402_PRIVATE_KEY set) can run q402_clear_delegation.",
  inputSchema: {
    type: "object" as const,
    properties: {
      src: {
        type: "string" as const,
        enum: ["eth", "avax", "arbitrum"],
        description: "Source chain.",
      },
      dst: {
        type: "string" as const,
        enum: ["eth", "avax", "arbitrum"],
        description: "Destination chain (MUST differ from src).",
      },
      amount: {
        type: "string" as const,
        pattern: "^\\d*[1-9]\\d*$",
        description: "USDC amount in raw 6-decimal units (e.g. '1000000' = 1 USDC). Integer string, > 0.",
      },
      walletId: {
        type: "string" as const,
        description: "Agentic Wallet ID (from q402_agentic_info). Optional - defaults to the owner's default Agent Wallet when omitted.",
      },
      feeToken: {
        type: "string" as const,
        enum: ["LINK", "native"],
        description: "Fee token. Default: LINK (~10% cheaper).",
      },
      sandbox: {
        type: "boolean" as const,
        description: "Sandbox mode (default true). Set to false for a real on-chain bridge.",
      },
      maxFeeRaw: {
        type: "string" as const,
        pattern: "^[0-9]+$",
        description: "Optional client-side fee cap in raw 18-dec wei.",
      },
      confirm: {
        type: "boolean" as const,
        description:
          "MUST be true to fire a LIVE bridge (ignored in sandbox) - set only after the user " +
          "explicitly approved this exact bridge in chat. Omit (or false) on a live call to " +
          "preview without moving funds.",
      },
      consentToken: {
        type: "string" as const,
        description:
          "Two-phase consent token. Leave unset on the first live call to get a preview + " +
          "token; re-call with confirm:true AND this token after the user approves. Bound to " +
          "(src, dst, amount, feeToken) - re-derived server-side-of-the-tool and refused on mismatch.",
      },
    },
    required: ["src", "dst", "amount"],
  },
};

interface SandboxResponse {
  sandbox: true;
  messageId: string;
  txHash: string;
  note: string;
  src: string;
  dst: string;
  amount: string;
}

function sandbox(input: z.infer<typeof BridgeSendInputSchema>, note: string): SandboxResponse {
  return {
    sandbox: true,
    messageId: "0x" + "00".repeat(32),
    txHash: "0x" + "00".repeat(32),
    note,
    src: input.src,
    dst: input.dst,
    amount: input.amount,
  };
}

export async function runBridgeSend(input: z.infer<typeof BridgeSendInputSchema>) {
  // -- Sandbox by default ------------------------------------------------
  if (input.sandbox !== false) {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(
          sandbox(input, "Sandbox response. Pass `sandbox: false` AND set Q402_ENABLE_REAL_PAYMENTS=1 (with a live Q402_MULTICHAIN_API_KEY) to fire a real bridge."),
          null, 2,
        ),
      }],
    };
  }

  // -- Two-phase consent gate - LIVE bridge MOVES FUNDS (F3) ---------------
  // A live call (sandbox:false) must carry BOTH confirm:true AND a
  // consentToken bound to the money intent (src, dst, amount, feeToken).
  // confirm:true alone is a model-filled boolean a prompt-injected agent can
  // set; the token forces the bridge through a human-visible preview and pins
  // the exact params. When either is missing/stale we DO NOT hit the bridge
  // endpoint - we return a preview carrying the token the agent must echo back
  // after the user approves. The token is re-derived from the params about to
  // execute, so the previewed bridge is provably the one that fires. (walletId
  // is excluded so picking a wallet after the preview doesn't void consent.)
  const consentIntent = {
    t: "bridge",
    src: input.src,
    dst: input.dst,
    amount: input.amount,
    feeToken: input.feeToken === "native" ? "native" : "LINK",
    // Bind the fee ceiling too - it bounds what the user actually pays, so it
    // must not be addable/changeable after the preview.
    maxFeeRaw: input.maxFeeRaw ?? null,
    // Bind the funding wallet too (see q402_pay).
    wid: (input.walletId ?? "").toLowerCase(),
  };
  const consent = checkConsent(consentIntent, input.consentToken);
  if (input.confirm !== true || !consent.ok) {
    const walletDesc =
      typeof input.walletId === "string" && input.walletId.length > 0
        ? `wallet ${input.walletId.toLowerCase()}`
        : "your default Agent Wallet";
    const fee = input.feeToken === "native" ? "native" : "LINK";
    return {
      content: [{
        type: "text" as const,
        text:
          `Will bridge ${input.amount} raw USDC units from ${input.src} -> ${input.dst} ` +
          `via Chainlink CCIP from ${walletDesc} (fee paid in ${fee}). This MOVES FUNDS ` +
          `on-chain. Confirm with the user, then re-call with sandbox:false, confirm:true, ` +
          `AND consentToken="${consent.expected}".`,
      }],
    };
  }

  // -- Live mode gates ---------------------------------------------------
  // Bridge requires Multichain scope - resolver always returns multichain
  // for non-BNB chains. Bridge lanes are eth/avax/arbitrum only, so the
  // chain arg here just steers the auto-select; the multichain key is
  // what actually gets used.
  const resolved = resolveApiKey(input.src, "multichain");
  if (!resolved.apiKey) {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(
          sandbox(input, resolved.sandboxReason ?? "No live Multichain API key configured. Set Q402_MULTICHAIN_API_KEY to a q402_live_… key from https://q402.quackai.ai/payment."),
          null, 2,
        ),
      }],
    };
  }
  if (!resolved.apiKey.startsWith("q402_live_")) {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(
          sandbox(input, "Resolved API key is not a live key. Set Q402_MULTICHAIN_API_KEY to a q402_live_… key."),
          null, 2,
        ),
      }],
    };
  }
  if (!CONFIG.realPaymentsRequested) {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(
          sandbox(input, "Q402_ENABLE_REAL_PAYMENTS is not set to 1. Set the env var to fire a real bridge."),
          null, 2,
        ),
      }],
    };
  }

  // -- Resolve walletId --------------------------------------------------
  // Pick by explicit tool arg → Q402_AGENT_WALLET_ADDRESS env → let the
  // server default to the owner's first Agent Wallet. Same precedence as
  // q402_pay Mode C.
  const walletId =
    typeof input.walletId === "string" && input.walletId.length > 0
      ? input.walletId.toLowerCase()
      : CONFIG.walletId ?? undefined;
  const feeToken: "LINK" | "native" = input.feeToken === "native" ? "native" : "LINK";

  // -- Live request ------------------------------------------------------
  let resp: Response;
  try {
    // 90s timeout - bridge runs approve.wait() + bridge.wait() back-to-
    // back on the source chain, then writes idempotency + history.
    // ETH mainnet alone can eat 15-20s; 90s gives 30s headroom over the
    // server's own 60s maxDuration.
    resp = await fetch(`${CONFIG.relayBaseUrl}/wallet/agentic/bridge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: resolved.apiKey,
        ...(walletId ? { walletId } : {}),
        src: input.src,
        dst: input.dst,
        amount: input.amount,
        feeToken,
        ...(input.maxFeeRaw ? { maxFeeRaw: input.maxFeeRaw } : {}),
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e) {
    return {
      content: [{
        type: "text" as const,
        text:
          `Bridge fetch failed: ${e instanceof Error ? e.message : String(e)}. ` +
          `Retry; if the relay 60s budget timed out, the bridge may still be in flight - ` +
          `check the dashboard's Bridge History or CCIP Explorer before re-firing.`,
      }],
      isError: true,
    };
  }
  const data = (await resp.json().catch(() => ({}))) as Record<string, unknown> & {
    success?: boolean;
    messageId?: string;
    txHash?: string;
    feeWhole?: number;
    feeToken?: string;
    ccipExplorer?: string;
    srcExplorer?: string;
    agentFundTxHash?: string;
    agentFundEth?: number;
    error?: string;
    message?: string;
    detail?: string;
  };

  if (!resp.ok || !data.success) {
    // Surface the relay's error envelope verbatim - the friendly-error
    // mapper on the landing side picks up the same codes (the dashboard
    // bridge modal uses them too).
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          sandbox: false,
          httpStatus: resp.status,
          ...data,
        }, null, 2),
      }],
      isError: true,
    };
  }

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        sandbox: false,
        success: true,
        messageId: data.messageId,
        txHash: data.txHash,
        feeWhole: data.feeWhole,
        feeToken: data.feeToken,
        ccipExplorer: data.ccipExplorer,
        srcExplorer: data.srcExplorer,
        ...(data.agentFundTxHash ? { agentFundTxHash: data.agentFundTxHash, agentFundEth: data.agentFundEth } : {}),
        note:
          "Bridge submitted on source chain. CCIP delivery to destination chain typically takes " +
          "8-25 minutes. Track via the ccipExplorer URL above.",
      }, null, 2),
    }],
  };
}
