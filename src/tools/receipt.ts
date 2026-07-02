/**
 * q402_receipt — read-only, no API key required.
 *
 * Looks up a Q402 Trust Receipt **by receiptId** and returns the public-shaped
 * record plus a `verified` boolean from a client-side ECDSA recovery against
 * the relayer EOA. txHash-only lookup is **not** supported in v0.2.x — the
 * public JSON endpoint doesn't expose the tx → receiptId index yet, so the
 * tool returns notFound when given txHash alone. Pass `receiptId` (rct_…)
 * for everything that exists today.
 *
 * The receipt itself is the canonical settlement attestation produced by the
 * relay route — every successful POST /api/relay creates one (with a backfill
 * cron as the durability safety net). The MCP tool exists so an agent can:
 *
 *   - hand the user a verifiable URL after a payment ("here's the receipt")
 *   - independently check that a receipt the user shared is actually signed
 *     by the relayer ("verify this rct_… is real")
 *   - audit by tx hash without needing the receipt id ("did this tx produce
 *     a receipt?")
 *
 * Verification is deliberately done locally inside this tool — the receipt
 * page already runs the same check in the browser, but exposing it through
 * MCP lets agents reason about the truthfulness of a receipt without a
 * round-trip through a UI.
 */

import { z } from "zod";
import { keccak256, toUtf8Bytes, getBytes, verifyMessage } from "ethers";
import { CONFIG } from "../config.js";

// Public-shaped fields. Mirrors app/lib/receipt-shared.ts on the server side.
const ReceiptShape = z.object({
  receiptId:      z.string(),
  createdAt:      z.string(),
  txHash:         z.string(),
  blockNumber:    z.number().optional(),
  chain:          z.string(),
  payer:          z.string(),
  recipient:      z.string(),
  token:          z.enum(["USDC", "USDT", "RLUSD", "USDG"]),
  tokenAmount:    z.string(),
  tokenAmountRaw: z.string(),
  method:         z.enum(["eip7702", "eip3009", "eip7702_xlayer", "eip7702_stable"]),
  gasCostNative:  z.string().optional(),
  apiKeyTier:     z.string().optional(),       // hidden by default in publicView
  showTier:       z.boolean(),
  sandbox:        z.boolean(),
  webhook: z.object({
    configured:       z.boolean(),
    event:            z.string(),
    deliveryStatus:   z.enum(["pending", "delivered", "failed", "not_configured"]),
    attempts:         z.number().optional(),
    lastStatusCode:   z.number().optional(),
    lastError:        z.string().optional(),
    deliveredAt:      z.string().optional(),
    payloadSha256:    z.string().optional(),
    signatureSha256:  z.string().optional(),
  }),
  signature:      z.string(),
  signedBy:       z.string(),
  signedAt:       z.string(),
});

export type Receipt = z.infer<typeof ReceiptShape>;

// Subset that goes into the canonical hash — must match
// app/lib/receipt-shared.ts ReceiptSignedFields exactly. Sorted-keys JSON +
// keccak256 + EIP-191 personal_sign on the server; we reproduce here for
// local verification.
type SignedFields = Pick<Receipt,
  | "receiptId" | "createdAt" | "txHash" | "chain"
  | "payer" | "recipient" | "token" | "tokenAmount"
  | "tokenAmountRaw" | "method" | "sandbox"
>;

function canonicalize(fields: SignedFields): string {
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(fields).sort()) {
    sorted[k] = (fields as unknown as Record<string, unknown>)[k];
  }
  return JSON.stringify(sorted);
}

function digest(canonical: string): string {
  return keccak256(toUtf8Bytes(canonical));
}

// The Q402 relayer EOA that signs every Trust Receipt — app/lib/wallets.ts
// RELAYER_ADDRESS, which app/lib/relayer-key.ts asserts the signing key derives
// to. The `verified` boolean is only a real trust signal if it anchors here:
// recovering against the receipt's OWN self-reported signedBy (the previous
// behaviour) just checks internal consistency, so a receipt forged + signed by
// any attacker key and labelled with a matching signedBy would pass. Hardcoded
// — the signer is a stable, publicly-known address; the on-chain key-rotation
// guard keeps every receipt anchored to it.
const RELAYER_SIGNER = "0xfc77ff29178b7286a8ba703d7a70895ca74ff466";

function verifyReceiptSignature(r: Receipt): boolean {
  try {
    const fields: SignedFields = {
      receiptId:      r.receiptId,
      createdAt:      r.createdAt,
      txHash:         r.txHash,
      chain:          r.chain,
      payer:          r.payer,
      recipient:      r.recipient,
      token:          r.token,
      tokenAmount:    r.tokenAmount,
      tokenAmountRaw: r.tokenAmountRaw,
      method:         r.method,
      sandbox:        r.sandbox,
    };
    const recovered = verifyMessage(getBytes(digest(canonicalize(fields))), r.signature).toLowerCase();
    // Must recover to the known relayer AND the receipt must claim that signer.
    return recovered === RELAYER_SIGNER && r.signedBy.toLowerCase() === RELAYER_SIGNER;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool input + output
// ─────────────────────────────────────────────────────────────────────────────

export const ReceiptInputSchema = z.object({
  receiptId: z.string()
    .regex(/^rct_[0-9a-f]{24}$/, "receiptId must match rct_<24-hex>")
    .optional(),
  txHash: z.string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "txHash must be a 0x-prefixed 32-byte hex")
    .optional(),
}).refine(v => !!v.receiptId || !!v.txHash, {
  message: "Provide receiptId OR txHash (at least one)",
});

export type ReceiptInput = z.infer<typeof ReceiptInputSchema>;

export interface ReceiptSummary {
  receiptId:    string | null;
  url:          string | null;
  /** Pretty link to the human-readable receipt page. */
  pageUrl:      string | null;
  /** ECDSA recovery against the relayer EOA happened locally inside this tool. */
  verified:     boolean;
  /** Echo of the on-chain block explorer URL for the underlying tx. */
  explorerUrl:  string | null;
  receipt:      Receipt | null;
  notFound?:    boolean;
}

const EXPLORERS: Record<string, (h: string) => string> = {
  bnb:       h => `https://bscscan.com/tx/${h}`,
  eth:       h => `https://etherscan.io/tx/${h}`,
  avax:      h => `https://snowtrace.io/tx/${h}`,
  xlayer:    h => `https://www.oklink.com/xlayer/tx/${h}`,
  stable:    h => `https://stable-explorer.io/tx/${h}`,
  mantle:    h => `https://mantlescan.xyz/tx/${h}`,
  injective: h => `https://blockscout.injective.network/tx/${h}`,
};

// /api/relay → /api/receipt/{id} share the same /api root.
function receiptApiBase(): string {
  return CONFIG.relayBaseUrl;
}

// Public page is served from the host root, not /api.
function pageBase(): string {
  return CONFIG.relayBaseUrl.replace(/\/api\/?$/, "");
}

export async function runReceipt(input: ReceiptInput): Promise<ReceiptSummary> {
  const apiBase = receiptApiBase();

  // Resolve receiptId — directly given, or looked up via the relay's
  // /api/receipt index. We use the public JSON endpoint, which already
  // strips server-only fields (apiKeyId, optional apiKeyTier).
  const receiptId = input.receiptId ?? null;

  if (!receiptId && input.txHash) {
    // No public tx-lookup endpoint exists today; the relay route owns the
    // receipt-by-tx mapping privately. The agent should pass receiptId when
    // it has one. We surface a clear notFound so the agent can ask the
    // user for the rct_ id instead of looping.
    return {
      receiptId:   null,
      url:         null,
      pageUrl:     null,
      verified:    false,
      explorerUrl: null,
      receipt:     null,
      notFound:    true,
    };
  }

  if (!receiptId) {
    return {
      receiptId: null, url: null, pageUrl: null, verified: false,
      explorerUrl: null, receipt: null, notFound: true,
    };
  }

  // 10s timeout — receipt read is a small static lookup; a stall longer
  // than that means the relay is unhealthy and we should fail the tool
  // call explicitly instead of hanging the MCP session indefinitely.
  const resp = await fetch(`${apiBase}/receipt/${receiptId}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (resp.status === 404) {
    return {
      receiptId, url: null, pageUrl: null, verified: false,
      explorerUrl: null, receipt: null, notFound: true,
    };
  }
  if (!resp.ok) {
    throw new Error(`receipt fetch failed: HTTP ${resp.status}`);
  }

  const raw = await resp.json();
  const receipt = ReceiptShape.parse(raw);

  const pUrl       = `${pageBase()}/receipt/${receipt.receiptId}`;
  const explorer   = EXPLORERS[receipt.chain];
  const explorerUrl = explorer ? explorer(receipt.txHash) : null;
  const verified   = verifyReceiptSignature(receipt);

  return {
    receiptId:   receipt.receiptId,
    url:         pUrl,
    pageUrl:     pUrl,
    verified,
    explorerUrl,
    receipt,
  };
}

export const RECEIPT_TOOL = {
  name: "q402_receipt",
  description:
    "Look up a Q402 Trust Receipt by its rct_… receiptId and return the settlement record + a locally-verified " +
    "ECDSA boolean (the tool re-runs the same canonical-JSON + EIP-191 recovery the receipt page does in the " +
    "browser). Read-only; no API key required. Use after q402_pay to give the user a shareable verified-by-Q402 URL, " +
    "or to independently verify a receipt id someone shared with you. " +
    "**receiptId is required**; passing only txHash returns notFound (tx → receiptId lookup is reserved for a future release).",
  inputSchema: {
    type: "object" as const,
    properties: {
      receiptId: {
        type:        "string",
        pattern:     "^rct_[0-9a-f]{24}$",
        description: "Receipt id (rct_ + 24 hex chars). Returned by q402_pay; also visible at the end of any /receipt/ URL. This is the only path that resolves today.",
      },
      txHash: {
        type:        "string",
        pattern:     "^0x[0-9a-fA-F]{64}$",
        description: "Reserved for a future tx → receipt index. Today this is unimplemented and the tool returns notFound when only txHash is provided. Pass receiptId instead.",
      },
    },
    additionalProperties: false,
  },
} as const;
