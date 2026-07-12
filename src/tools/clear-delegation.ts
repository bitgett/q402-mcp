/**
 * q402_clear_delegation - clear an EIP-7702 delegation on a Q402 chain.
 *
 * Three wallet modes, mirroring q402_pay:
 *
 *   - eoa            (Mode A) - sign locally with Q402_PRIVATE_KEY, POST the
 *                    signed authorization to /api/wallet/clear-delegation
 *                    (the signature IS the auth). Key never leaves the machine.
 *   - agentic-local  (Mode B) - same local-sign path, but with the Agent
 *                    Wallet's exported key (Q402_AGENTIC_PRIVATE_KEY).
 *   - agentic-server (Mode C) - NO local key. The MCP only holds a live
 *                    apiKey; it POSTs { apiKey, chain, walletId? } to
 *                    /api/wallet/agentic/clear-delegation, where the server
 *                    decrypts the Agent Wallet key and signs the clear. This
 *                    is the path that lets a server-managed wallet switch off
 *                    the q402 rail (e.g. to use x402) without the dashboard.
 *
 * Q402 sponsors the on-chain type-0x04 TX on every chain EXCEPT Ethereum,
 * where the gas is billed to the user's Gas Tank. Requires a matching
 * consentToken to broadcast (omit it first for a preview, then re-call with
 * the token). After clearing, eth_getCode for that wallet on that chain
 * returns 0x again; the next q402_pay re-creates it.
 *
 * Mode resolution: an explicit `walletMode` wins. Otherwise, when exactly one
 * mode is configured it's used; when several are, the tool refuses and asks
 * (AMBIGUOUS_WALLET_MODE) rather than guessing - same contract as q402_pay.
 */

import { z } from "zod";
import { Wallet, JsonRpcProvider } from "ethers";
import { CONFIG, detectAgenticModes, resolveApiKey } from "../config.js";
import { checkConsent } from "../consent.js";
import { CHAIN_CONFIG, CHAIN_KEYS, type ChainConfig, type ChainKey } from "../chains.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Default RPC per chain - mirrors mcp-server/src/client.ts so the
// nonce lookup uses the same RPC defaults the rest of the package does.
const DEFAULT_RPC: Record<number, string> = {
  1:      "https://ethereum.publicnode.com",
  56:     "https://bsc-dataseed1.binance.org/",
  143:    "https://rpc.monad.xyz",
  196:    "https://rpc.xlayer.tech",
  988:    "https://rpc.stable.xyz",
  1776:   "https://sentry.evm-rpc.injective.network/",
  5000:   "https://rpc.mantle.xyz",
  8453:   "https://mainnet.base.org",
  42161:  "https://arb1.arbitrum.io/rpc",
  43114:  "https://api.avax.network/ext/bc/C/rpc",
  534352: "https://rpc.scroll.io",
};

export const ClearDelegationInputSchema = z.object({
  chain: z
    .enum(["avax", "bnb", "eth", "xlayer", "stable", "mantle", "injective", "monad", "scroll", "arbitrum", "base"])
    .describe("Which Q402 chain to clear the delegation on."),
  walletMode: z
    .enum(["eoa", "agentic-local", "agentic-server"])
    .optional()
    .describe(
      'Which wallet to clear. "eoa" = Q402_PRIVATE_KEY, "agentic-local" = ' +
        'Q402_AGENTIC_PRIVATE_KEY (both sign locally), "agentic-server" = ' +
        "server-managed Agent Wallet (apiKey only, no private key). Omit when " +
        "only one mode is configured; required when several are.",
    ),
  walletId: z
    .string()
    .optional()
    .describe(
      'Server-managed Agent Wallet only (walletMode="agentic-server"). ' +
        "Lowercased Agent Wallet address when you hold more than one; omit to " +
        "use your single/default wallet (the server refuses with AMBIGUOUS_WALLET " +
        "if you have several and don't specify).",
    ),
  consentToken: z
    .string()
    .optional()
    .describe(
      "Two-phase consent. LEAVE THIS UNSET on the first call: the tool does " +
        "NOT broadcast - it returns status=\"needs_confirmation\" with a " +
        "human-readable `preview` (including whether Ethereum bills your Gas " +
        "Tank) and a `consentToken`. Relay the preview to the user; only after " +
        "they approve, re-call with the SAME args plus this token. The token is " +
        "re-derived from the resolved chain + wallet, so a previewed clear can't " +
        "be swapped for a different one.",
    ),
});

export type ClearDelegationInput = z.infer<typeof ClearDelegationInputSchema>;

interface ClearDelegationResult {
  ok:           boolean;
  mode?:        "eoa" | "agentic-local" | "agentic-server";
  chain?:       ChainKey;
  address?:     string;
  walletId?:    string;
  txHash?:      string;
  blockNumber?: number;
  gasUsed?:     string;
  explorerUrl?: string;
  /** True when the post-broadcast eth_getCode returns 0x - confirms the
   *  delegation is actually gone. False (or absent) means the TX confirmed
   *  but the on-chain state didn't update - likely a stale authorization
   *  nonce; retry after refreshing the wallet's tx count. */
  cleared?:     boolean;
  /** True when the wallet was already undelegated (no TX needed). */
  alreadyCleared?: boolean;
  /** When ok=false and the mode was ambiguous, the modes the env can drive. */
  availableModes?: string[];
  /** Set when no matching consentToken was supplied - the clear was NOT
   *  broadcast. The agent must relay `preview` to the user, get a yes, then
   *  re-call with the same args plus `needsConsent.consentToken`. */
  needsConsent?: {
    status: "needs_confirmation";
    preview: string;
    consentToken: string;
  };
  /** When ok=false, machine-readable code. */
  error?:       string;
  /** When ok=false, human-readable next step. */
  hint?:        string;
}

export async function runClearDelegation(input: ClearDelegationInput): Promise<ClearDelegationResult> {
  const cfg = CHAIN_CONFIG[input.chain];
  if (!cfg) {
    return { ok: false, error: "INVALID_CHAIN", hint: `Unknown chain: ${input.chain}` };
  }

  // -- Resolve the effective wallet mode (mirror q402_pay's contract) ----
  const modes = detectAgenticModes();
  let mode: "eoa" | "agentic-local" | "agentic-server";
  if (input.walletMode) {
    mode = input.walletMode;
    if (mode === "eoa" && !modes.modeA) {
      return modeUnavailable("eoa", "Q402_PRIVATE_KEY");
    }
    if (mode === "agentic-local" && !modes.modeB) {
      return modeUnavailable("agentic-local", "Q402_AGENTIC_PRIVATE_KEY");
    }
    if (mode === "agentic-server" && !modes.modeC) {
      return modeUnavailable("agentic-server", "a live Q402_MULTICHAIN_API_KEY (q402_live_…)");
    }
  } else {
    if (modes.count === 0) {
      return {
        ok:    false,
        error: "MISSING_CREDENTIALS",
        hint:
          "No wallet is configured. Set Q402_PRIVATE_KEY (Mode A), " +
          "Q402_AGENTIC_PRIVATE_KEY (Mode B), or a live Q402_MULTICHAIN_API_KEY " +
          "(Mode C) in the MCP environment.",
      };
    }
    if (modes.count > 1) {
      const available = [
        modes.modeA ? "eoa" : null,
        modes.modeB ? "agentic-local" : null,
        modes.modeC ? "agentic-server" : null,
      ].filter((m): m is string => m !== null);
      return {
        ok:    false,
        error: "AMBIGUOUS_WALLET_MODE",
        hint:
          "Multiple wallet modes are configured. Pass walletMode to choose " +
          `which wallet to clear (one of: ${available.join(", ")}).`,
        availableModes: available,
      };
    }
    mode = modes.primary === "A" ? "eoa" : modes.primary === "B" ? "agentic-local" : "agentic-server";
  }

  // -- Mode B (agentic-local) + Ethereum guard ---------------------------
  // eth undelegate is billed to the Agent Wallet OWNER's Gas Tank, but the
  // local signature-auth endpoint can only see the agent address - it can't
  // resolve (or bill) the owner. So route eth+Mode-B to the Mode C apiKey path
  // (which bills the owner correctly) instead of letting the user hit an
  // unactionable 402.
  if (mode === "agentic-local" && input.chain === "eth") {
    return {
      ok:    false,
      mode,
      chain: "eth",
      error: "ETH_CLEAR_NEEDS_OWNER_TANK",
      hint:
        "Ethereum undelegate is billed to the Agent Wallet OWNER's Gas Tank, " +
        'which local (Mode B) signing can\'t reach. Use walletMode: "agentic-server" ' +
        "(set a live Q402_MULTICHAIN_API_KEY) or clear eth from the dashboard.",
    };
  }

  // -- Two-phase consent (token-bound, mirrors q402_pay) -----------------
  // Bind the RESOLVED mode + the walletId the tool will actually send, so a
  // preview for one wallet can't execute against another (preview→execute
  // bait-and-switch). The token is a hash of these fields (not secret) - the
  // security is the forced human-visible preview round-trip that a one-shot
  // prompt injection can't skip. No signing/broadcast on the preview path.
  const resolvedWalletId =
    (typeof input.walletId === "string" && input.walletId.length > 0
      ? input.walletId
      : CONFIG.walletId ?? "").toLowerCase();
  const consentIntent = {
    action:   "clear_delegation",
    chain:    input.chain,
    mode,
    walletId: resolvedWalletId,
  };
  const consent = checkConsent(consentIntent, input.consentToken);
  if (!consent.ok) {
    const gasNote =
      input.chain === "eth"
        ? "Gas is billed to your Gas Tank on Ethereum."
        : "Q402 sponsors the gas, so you pay $0.";
    return {
      ok:    false,
      mode,
      chain: input.chain,
      needsConsent: {
        status:  "needs_confirmation",
        preview:
          `Clear the EIP-7702 delegation for your ${mode} wallet on ${input.chain}` +
          `${
            resolvedWalletId
              ? ` (${resolvedWalletId})`
              : mode === "agentic-server"
                ? " (your DEFAULT Agent Wallet, resolved server-side - pass walletId to target a specific one)"
                : ""
          }. ` +
          `This sends a real on-chain transaction. ${gasNote} ` +
          "The next q402_pay on this chain re-creates the delegation. " +
          "Confirm with the user, then re-call with the same args plus this consentToken.",
        consentToken: consent.expected,
      },
    };
  }

  if (mode === "agentic-server") {
    return runClearModeC(input, cfg);
  }
  const signingKey = mode === "agentic-local" ? CONFIG.agenticPrivateKey : CONFIG.privateKey;
  return runClearLocal(input, cfg, mode, signingKey!);
}

function modeUnavailable(mode: string, envHint: string): ClearDelegationResult {
  return {
    ok:    false,
    error: "WALLET_MODE_UNAVAILABLE",
    hint:  `walletMode="${mode}" requested but ${envHint} is not configured in the MCP environment.`,
  };
}

/**
 * Mode A/B - sign the EIP-7702 clear authorization LOCALLY with the given
 * private key and POST it to /api/wallet/clear-delegation (signature == auth).
 */
async function runClearLocal(
  input: ClearDelegationInput,
  cfg: ChainConfig,
  mode: "eoa" | "agentic-local",
  signingKey: string,
): Promise<ClearDelegationResult> {
  // -- 1. Derive EOA + read current nonce --------------------------------
  let wallet: Wallet;
  try {
    const provider = new JsonRpcProvider(DEFAULT_RPC[cfg.chainId]);
    wallet = new Wallet(signingKey, provider);
  } catch {
    return {
      ok:    false,
      error: "INVALID_PRIVATE_KEY",
      hint:  `The ${mode === "agentic-local" ? "Q402_AGENTIC_PRIVATE_KEY" : "Q402_PRIVATE_KEY"} is set but does not parse as a valid 32-byte hex private key.`,
    };
  }

  const address = wallet.address;
  let nonce: number;
  try {
    nonce = await wallet.provider!.getTransactionCount(address);
  } catch (e) {
    return {
      ok:    false,
      address,
      error: "RPC_FAILED",
      hint:  `Could not read transaction count for ${address} on ${input.chain}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // -- 2. Sign EIP-7702 authorization (address = 0x0 → clear) ------------
  let auth;
  try {
    auth = await wallet.authorize({
      chainId: cfg.chainId,
      address: ZERO_ADDRESS,
      nonce,
    });
  } catch (e) {
    return {
      ok:    false,
      address,
      error: "SIGN_FAILED",
      hint:  `Local signing failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // -- 3. POST to Q402 for sponsored broadcast ---------------------------
  const url  = `${CONFIG.relayBaseUrl.replace(/\/$/, "")}/wallet/clear-delegation`;
  const body = {
    chain:   input.chain,
    address,
    authorization: {
      chainId: Number(auth.chainId),
      address: auth.address,
      nonce:   Number(auth.nonce),
      yParity: auth.signature.yParity,
      r:       auth.signature.r,
      s:       auth.signature.s,
    },
  };

  let res: Response;
  let json: unknown;
  try {
    res  = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(30_000),
    });
    json = await res.json();
  } catch (e) {
    return {
      ok:    false,
      address,
      error: "RELAY_UNREACHABLE",
      hint:  `Could not reach Q402 relay at ${url}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const payload = json as {
    ok?:          boolean;
    txHash?:      string;
    blockNumber?: number;
    gasUsed?:     string;
    finalCode?:   string;
    cleared?:     boolean;
    explorerUrl?: string;
    error?:       string;
    reason?:      string;
  };

  if (!res.ok || payload.cleared !== true) {
    return {
      ok:          false,
      mode,
      chain:       input.chain,
      address,
      txHash:      payload.txHash,
      blockNumber: payload.blockNumber,
      gasUsed:     payload.gasUsed,
      cleared:     payload.cleared ?? false,
      explorerUrl: payload.explorerUrl,
      error:       payload.error ?? `HTTP ${res.status}`,
      hint:        payload.reason ?? "The sponsored TX did not clear the delegation. If a txHash is present, the broadcast confirmed but the EOA's code is still non-empty (commonly a stale nonce) - refresh and retry.",
    };
  }

  return {
    ok:          true,
    mode,
    chain:       input.chain,
    address,
    txHash:      payload.txHash!,
    blockNumber: payload.blockNumber!,
    gasUsed:     payload.gasUsed!,
    cleared:     true,
    explorerUrl: payload.explorerUrl!,
  };
}

/**
 * Mode C - server-managed Agent Wallet. No local key: present the live apiKey
 * and let the server sign the clear with the encrypted Agent Wallet key.
 */
async function runClearModeC(
  input: ClearDelegationInput,
  cfg: ChainConfig,
): Promise<ClearDelegationResult> {
  // BNB prefers the Trial key (server allows clearing on BNB with it);
  // every other chain routes to the Multichain key.
  const resolved = resolveApiKey(input.chain, "auto");
  if (!resolved.apiKey || !resolved.apiKey.startsWith("q402_live_")) {
    return {
      ok:    false,
      mode:  "agentic-server",
      error: "NO_LIVE_API_KEY",
      hint:
        resolved.sandboxReason ??
        "Mode C clear needs a live API key (q402_live_…). Set Q402_MULTICHAIN_API_KEY in the MCP environment.",
    };
  }
  if (!CONFIG.realPaymentsRequested) {
    return {
      ok:    false,
      mode:  "agentic-server",
      error: "REAL_PAYMENTS_DISABLED",
      hint:
        "Set Q402_ENABLE_REAL_PAYMENTS=1 in your MCP env to let the server " +
        "broadcast the clear (it submits a real on-chain TX).",
    };
  }

  const walletId =
    typeof input.walletId === "string" && input.walletId.length > 0
      ? input.walletId.toLowerCase()
      : CONFIG.walletId ?? undefined;

  const url  = `${CONFIG.relayBaseUrl}/wallet/agentic/clear-delegation`;
  const body = {
    apiKey: resolved.apiKey,
    chain:  input.chain,
    ...(walletId ? { walletId } : {}),
  };

  let res: Response;
  let json: unknown;
  try {
    // 45s - the server signs + mines a sponsored type-0x04 TX; matches the
    // route's maxDuration headroom.
    res  = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(45_000),
    });
    json = await res.json();
  } catch (e) {
    return {
      ok:    false,
      mode:  "agentic-server",
      error: "RELAY_UNREACHABLE",
      hint:  `Could not reach Q402 relay at ${url}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const payload = json as {
    success?:       boolean;
    alreadyCleared?: boolean;
    txHash?:        string;
    blockNumber?:   number;
    gasUsed?:       string;
    finalCode?:     string;
    address?:       string;
    chain?:         string;
    message?:       string;
    error?:         string;
    detail?:        string;
    wallets?:       string[];
  };

  // Already undelegated - no TX, treat as success.
  if (res.ok && payload.alreadyCleared === true) {
    return {
      ok:             true,
      mode:           "agentic-server",
      chain:          input.chain,
      address:        payload.address,
      walletId,
      cleared:        true,
      alreadyCleared: true,
    };
  }

  if (!res.ok || payload.success !== true) {
    return {
      ok:          false,
      mode:        "agentic-server",
      chain:       input.chain,
      address:     payload.address,
      walletId,
      txHash:      payload.txHash,
      cleared:     payload.finalCode === "0x" ? true : false,
      error:       payload.error ?? `HTTP ${res.status}`,
      hint:
        payload.detail ??
        payload.message ??
        (payload.wallets
          ? `You have multiple Agent Wallets (${payload.wallets.join(", ")}). Pass walletId to choose one.`
          : "The server did not clear the delegation. If a txHash is present, the TX confirmed but the wallet is still delegated (commonly a stale nonce) - retry shortly."),
    };
  }

  return {
    ok:          true,
    mode:        "agentic-server",
    chain:       input.chain,
    address:     payload.address,
    walletId,
    txHash:      payload.txHash,
    blockNumber: payload.blockNumber,
    gasUsed:     payload.gasUsed,
    cleared:     payload.finalCode === "0x",
    explorerUrl: payload.txHash ? `${cfg.explorer.replace(/\/$/, "")}/tx/${payload.txHash}` : undefined,
  };
}

export const CLEAR_DELEGATION_TOOL = {
  name: "q402_clear_delegation",
  description:
    "Clear the EIP-7702 delegation on a Q402 chain for the configured wallet. " +
    "Call this when the user wants to reset a chain's delegation, OR to switch " +
    "a wallet off the q402 rail so it can use the x402 (EIP-3009) rail on Base " +
    "(a q402-delegated wallet can't settle x402). The next q402_pay on the same " +
    "chain re-creates the delegation automatically, so don't clear right before " +
    "a normal pay. Pair with q402_wallet_status / q402_agentic_info first to see " +
    "which chains have an active delegation. " +
    "Works in all three wallet modes: eoa (Q402_PRIVATE_KEY) and agentic-local " +
    "(Q402_AGENTIC_PRIVATE_KEY) sign LOCALLY; agentic-server (Mode C) holds only " +
    "a live apiKey and the server signs with the encrypted Agent Wallet key. " +
    "Q402 sponsors the on-chain TX on every chain EXCEPT Ethereum, where the " +
    "gas is billed to your Gas Tank. Two-phase consent: call once WITHOUT " +
    "consentToken to get a preview + token (no broadcast), then re-call with " +
    "the same args plus that consentToken to execute.",
  inputSchema: {
    type: "object" as const,
    properties: {
      chain: {
        type: "string",
        enum: CHAIN_KEYS as readonly string[],
        description: "Which Q402 chain to clear the delegation on.",
      },
      consentToken: {
        type: "string",
        description:
          "Two-phase consent. Omit on the first call to get a needs_confirmation " +
          "preview + consentToken (no broadcast); re-call with the SAME args plus " +
          "this token to execute. Re-derived from the resolved chain + wallet.",
      },
      walletMode: {
        type: "string",
        enum: ["eoa", "agentic-local", "agentic-server"],
        description:
          'Which wallet to clear. "eoa" = Q402_PRIVATE_KEY, "agentic-local" = ' +
          'Q402_AGENTIC_PRIVATE_KEY (both sign locally), "agentic-server" = ' +
          "server-managed Agent Wallet (apiKey only, no private key). Omit when " +
          "only one mode is configured; required when several are.",
      },
      walletId: {
        type: "string",
        description:
          'Server-managed Agent Wallet only (walletMode="agentic-server"). ' +
          "Lowercased Agent Wallet address when you hold more than one; omit to " +
          "use your single/default wallet.",
      },
    },
    required: ["chain"],
    additionalProperties: false,
  },
} as const;
