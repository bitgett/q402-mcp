/**
 * Q402 Gasless Escrow MCP tools - create / status / lock / release / refund /
 * dispute a non-custodial EIP-7702 escrow.
 *
 * Flow: escrow_create (apiKey, moves no funds) publishes a `pending` record and
 * returns an escrowId. The buyer funds it with escrow_lock (a gasless EIP-7702
 * tx: the buyer signs an EscrowLock witness + a 7702 authorization; Q402 relays).
 * Then escrow_release (buyer -> seller), escrow_refund (permissionless after the
 * deadline -> buyer), or escrow_dispute (a named arbiter later resolves). Every
 * fund-affecting field is server-derived from the stored record + on-chain
 * config; the EIP-712 signatures are the sole authority.
 *
 * Live only where a vault is deployed (currently BNB mainnet). SANDBOX-adjacent
 * note: unlike q402_pay there is no fake path - a lock/release with a live key
 * moves real funds, so ALWAYS confirm with the user first (confirm:true).
 */
import { Wallet, JsonRpcProvider, isAddress, ZeroAddress } from "ethers";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { CONFIG } from "../config.js";
import { toRawAmount } from "../client.js";

// EIP-712 type sets - MUST match Q402EscrowVault / Q402EscrowLockImpl exactly.
const ESCROW_LOCK_TYPES = {
  EscrowLock: [
    { name: "buyer", type: "address" }, { name: "seller", type: "address" }, { name: "vault", type: "address" },
    { name: "token", type: "address" }, { name: "amount", type: "uint256" }, { name: "salt", type: "bytes32" },
    { name: "releaseDeadline", type: "uint256" }, { name: "arbiter", type: "address" }, { name: "facilitator", type: "address" },
    { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ],
};
const RELEASE_TYPES = { EscrowRelease: [{ name: "escrowId", type: "bytes32" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] };
const DISPUTE_TYPES = { EscrowDispute: [{ name: "escrowId", type: "bytes32" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] };

const ESCROW_CHAINS = ["bnb", "sepolia"] as const;

interface EscrowInfo {
  chainId: number; rpc: string; vault: string; lockImpl: string; facilitator: string;
  tokens: Record<string, string>; decimals: number; vaultDomainName: string; lockDomainName: string; explorerTx: string;
}
interface EscrowRecord {
  id: string; salt: string; onchainEscrowId: string; buyer: string; seller: string; chain: string;
  token: "USDC" | "USDT"; amount: string; arbiter?: string; releaseDeadline: string; status: string;
  /** "agent" when a server-managed Agent Wallet funds it - the server signs
   *  lock/release/dispute, so no local key is used for those. */
  fundedBy?: "owner" | "agent";
}

/** Fields the escrow API endpoints return (all optional; endpoint-specific). */
interface ApiResp {
  error?: string; escrowId?: string; onchainEscrowId?: string; escrow?: unknown;
  txHash?: string; explorer?: string; status?: string;
}

function base(): string { return CONFIG.relayBaseUrl.replace(/\/$/, ""); }
const HEX_PK = /^0x[0-9a-fA-F]{64}$/;
/**
 * The local signing wallet for escrow lock/release/dispute. Accepts the EOA key
 * (Q402_PRIVATE_KEY, Mode A) OR the Agent Wallet's exported key
 * (Q402_AGENTIC_PRIVATE_KEY, Mode B). When `expectedBuyer` is given (lock/release
 * are buyer-signed) it picks the key whose address IS the buyer, so a user with
 * both keys signs from the right one. Server-managed wallets (Mode C) can't sign
 * escrow locally - there's no local key.
 */
function signer(expectedBuyer?: string): Wallet {
  const cands = [CONFIG.privateKey, CONFIG.agenticPrivateKey].filter((k): k is string => !!k && HEX_PK.test(k));
  if (cands.length === 0) {
    throw new Error("Escrow lock/release/dispute need a local signing key: set Q402_PRIVATE_KEY (your EOA) or Q402_AGENTIC_PRIVATE_KEY (Agent Wallet). Server-managed wallets can't sign escrow locally.");
  }
  if (expectedBuyer) {
    const match = cands.find((k) => new Wallet(k).address.toLowerCase() === expectedBuyer.toLowerCase());
    if (!match) throw new Error(`No configured key matches the escrow buyer ${expectedBuyer}. Set that wallet's key as Q402_PRIVATE_KEY or Q402_AGENTIC_PRIVATE_KEY.`);
    return new Wallet(match);
  }
  return new Wallet(cands[0]!);
}
async function getInfo(chain: string): Promise<EscrowInfo> {
  const r = await fetch(`${base()}/escrow/info?chain=${encodeURIComponent(chain)}`, { signal: AbortSignal.timeout(15_000) });
  const j = (await r.json()) as EscrowInfo & { error?: string };
  if (!r.ok) throw new Error(j?.error ?? `escrow not live on ${chain}`);
  return j;
}
async function getEscrow(id: string): Promise<EscrowRecord> {
  const r = await fetch(`${base()}/escrow/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(15_000) });
  const j = (await r.json()) as EscrowRecord & { escrow?: EscrowRecord; error?: string };
  if (!r.ok) throw new Error(j?.error ?? "escrow not found");
  return j.escrow ?? j;
}
const nowSec = () => Math.floor(Date.now() / 1000);
const randNonce = () => BigInt("0x" + randomBytes(8).toString("hex")).toString();

// -- escrow_create ------------------------------------------------------------
export const EscrowCreateInputSchema = z.object({
  chain: z.enum(ESCROW_CHAINS),
  token: z.enum(["USDC", "USDT"]),
  seller: z.string().refine(isAddress, "seller must be a valid address"),
  amount: z.string().regex(/^\d+(\.\d+)?$/, "amount must be a positive decimal string"),
  arbiter: z.string().refine(isAddress, "arbiter must be a valid address").optional(),
  memo: z.string().max(200).optional(),
  releaseDays: z.number().int().positive().max(90).optional(),
  // Fund from one of YOUR Agent Wallets (its address). The server then signs the
  // lock/release gaslessly on that wallet's behalf - no local key needed. Omit to
  // make yourself (the API-key owner) the buyer (funded with your own key).
  walletId: z.string().refine(isAddress, "walletId must be an Agent Wallet address").optional(),
});
export type EscrowCreateInput = z.infer<typeof EscrowCreateInputSchema>;
export async function runEscrowCreate(input: EscrowCreateInput) {
  if (!CONFIG.apiKey) throw new Error("Q402_API_KEY (or a scoped key) is required to create an escrow.");
  const r = await fetch(`${base()}/escrow`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey: CONFIG.apiKey, ...input }), signal: AbortSignal.timeout(20_000),
  });
  const j = (await r.json()) as ApiResp;
  if (!r.ok) throw new Error(j?.error ?? "escrow create failed");
  return { escrowId: j.escrowId, onchainEscrowId: j.onchainEscrowId, escrow: j.escrow, note: "Record created (no funds moved). Fund it with escrow_lock." };
}

// -- escrow_status --------------------------------------------------------------
export const EscrowStatusInputSchema = z.object({ escrowId: z.string() });
export type EscrowStatusInput = z.infer<typeof EscrowStatusInputSchema>;
export async function runEscrowStatus(input: EscrowStatusInput) {
  const rec = await getEscrow(input.escrowId);
  return { escrow: rec };
}

// -- escrow_lock (gasless EIP-7702) --------------------------------------------
export const EscrowLockInputSchema = z.object({ escrowId: z.string(), confirm: z.literal(true) });
export type EscrowLockInput = z.infer<typeof EscrowLockInputSchema>;
export async function runEscrowLock(input: EscrowLockInput) {
  const rec = await getEscrow(input.escrowId);
  if (rec.status !== "pending") throw new Error(`escrow is ${rec.status}, not lockable`);
  // Agent-Wallet-funded: the server custodies the wallet key and signs the lock
  // gaslessly on its behalf - no local key. Authorize with the apiKey (Mode C);
  // the server enforces the wallet's spend caps.
  if (rec.fundedBy === "agent") {
    if (!CONFIG.apiKey) throw new Error("Q402_API_KEY is required to fund an Agent-Wallet escrow.");
    const r = await fetch(`${base()}/escrow/${encodeURIComponent(input.escrowId)}/lock`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: CONFIG.apiKey }), signal: AbortSignal.timeout(60_000),
    });
    const j = (await r.json()) as ApiResp;
    if (!r.ok) throw new Error(j?.error ?? "lock failed");
    return { status: "open", txHash: j.txHash, explorer: j.explorer, escrow: j.escrow };
  }
  const w = signer(rec.buyer); // must be the buyer; throws if no configured key matches
  const info = await getInfo(rec.chain);
  const provider = new JsonRpcProvider(info.rpc, info.chainId);
  const buyer = w.connect(provider);
  const nonce = randNonce();
  const deadline = String(nowSec() + 900);
  const p = {
    buyer: rec.buyer, seller: rec.seller, vault: info.vault, token: info.tokens[rec.token],
    amount: toRawAmount(rec.amount, info.decimals), salt: rec.salt,
    releaseDeadline: String(Math.floor(new Date(rec.releaseDeadline).getTime() / 1000)),
    arbiter: rec.arbiter ?? ZeroAddress, facilitator: info.facilitator, nonce, deadline,
  };
  const witnessSig = await buyer.signTypedData(
    { name: info.lockDomainName, version: "1", chainId: info.chainId, verifyingContract: rec.buyer }, ESCROW_LOCK_TYPES, p);
  const a = await buyer.authorize({ address: info.lockImpl });
  const authorization = { chainId: Number(a.chainId), address: a.address, nonce: Number(a.nonce), yParity: a.signature.yParity, r: a.signature.r, s: a.signature.s };
  const r = await fetch(`${base()}/escrow/${encodeURIComponent(input.escrowId)}/lock`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ witnessSig, authorization, nonce, deadline }), signal: AbortSignal.timeout(60_000),
  });
  const j = (await r.json()) as ApiResp;
  if (!r.ok) throw new Error(j?.error ?? "lock failed");
  return { status: "open", txHash: j.txHash, explorer: j.explorer, escrow: j.escrow };
}

// -- escrow_release / dispute (vault-signed) -----------------------------------
async function signVaultAction(id: string, types: Record<string, unknown>, buyerSigned: boolean, extra: Record<string, unknown> = {}) {
  const rec = await getEscrow(id);
  // Payouts on an Agent-Wallet-funded escrow require the OWNER's fresh approval,
  // which only the dashboard can collect (the MCP has no owner signing key). The
  // server-signed path deliberately refuses a bare apiKey for release/dispute.
  if (rec.fundedBy === "agent") {
    throw new Error("This escrow is funded by an Agent Wallet. Release or dispute it from the Q402 dashboard (Escrow view) - the payout needs the owner's approval.");
  }
  const info = await getInfo(rec.chain);
  const w = signer(buyerSigned ? rec.buyer : undefined);
  const nonce = randNonce();
  const deadline = String(nowSec() + 900);
  const sig = await w.signTypedData(
    { name: info.vaultDomainName, version: "1", chainId: info.chainId, verifyingContract: info.vault },
    types as never, { escrowId: rec.onchainEscrowId, nonce, deadline, ...extra });
  return { sig, nonce, deadline, rec, w };
}

export const EscrowReleaseInputSchema = z.object({ escrowId: z.string(), confirm: z.literal(true) });
export type EscrowReleaseInput = z.infer<typeof EscrowReleaseInputSchema>;
export async function runEscrowRelease(input: EscrowReleaseInput) {
  // buyerSigned=true -> signer() picks the buyer's key (or throws if none matches).
  const { sig, nonce, deadline } = await signVaultAction(input.escrowId, RELEASE_TYPES, true);
  const r = await fetch(`${base()}/escrow/${encodeURIComponent(input.escrowId)}/release`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sig, nonce, deadline }), signal: AbortSignal.timeout(60_000),
  });
  const j = (await r.json()) as ApiResp;
  if (!r.ok) throw new Error(j?.error ?? "release failed");
  return { status: j.status, txHash: j.txHash, explorer: j.explorer };
}

export const EscrowDisputeInputSchema = z.object({ escrowId: z.string(), confirm: z.literal(true) });
export type EscrowDisputeInput = z.infer<typeof EscrowDisputeInputSchema>;
export async function runEscrowDispute(input: EscrowDisputeInput) {
  // buyerSigned=false -> dispute can be signed by either party (buyer or seller);
  // the vault enforces party membership (NotAParty) on-chain.
  const { sig, nonce, deadline } = await signVaultAction(input.escrowId, DISPUTE_TYPES, false);
  const r = await fetch(`${base()}/escrow/${encodeURIComponent(input.escrowId)}/dispute`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sig, nonce, deadline }), signal: AbortSignal.timeout(60_000),
  });
  const j = (await r.json()) as ApiResp;
  if (!r.ok) throw new Error(j?.error ?? "dispute failed");
  return { status: j.status, txHash: j.txHash, explorer: j.explorer };
}

// -- escrow_refund (permissionless after the deadline) -------------------------
export const EscrowRefundInputSchema = z.object({ escrowId: z.string(), confirm: z.literal(true) });
export type EscrowRefundInput = z.infer<typeof EscrowRefundInputSchema>;
export async function runEscrowRefund(input: EscrowRefundInput) {
  const r = await fetch(`${base()}/escrow/${encodeURIComponent(input.escrowId)}/refund`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}), signal: AbortSignal.timeout(60_000),
  });
  const j = (await r.json()) as ApiResp;
  if (!r.ok) throw new Error(j?.error ?? "refund failed (only after the release deadline / resolve window)");
  return { status: j.status, txHash: j.txHash, explorer: j.explorer };
}

const CHAIN_ENUM = ESCROW_CHAINS as readonly string[];
const idProp = { escrowId: { type: "string" as const, description: "The esc_... id from escrow_create." } };
const confirmProp = { confirm: { type: "boolean" as const, const: true, description: "MUST be true, only after the user explicitly confirmed this exact escrow action in chat." } };

export const ESCROW_CREATE_TOOL = {
  name: "q402_escrow_create",
  description:
    "Create a Q402 Gasless Escrow (non-custodial, EIP-7702). Publishes a `pending` record and returns an escrowId - MOVES NO FUNDS. " +
    "Pass `walletId` (one of YOUR Agent Wallets) to make that wallet the buyer/funder: the server then signs the gasless lock on its behalf (no local key), so q402_escrow_lock funds it straight away. Omit walletId to make yourself (the apiKey owner) the buyer, funded with your own key. " +
    "Live on BNB mainnet (USDC/USDT). Optional arbiter enables disputes; without one it's release-or-timeout-refund only. Releasing an Agent-Wallet escrow needs the owner's approval in the dashboard.",
  inputSchema: { type: "object" as const, properties: {
    chain: { type: "string", enum: CHAIN_ENUM, description: "Chain with a deployed escrow vault (bnb)." },
    token: { type: "string", enum: ["USDC", "USDT"] },
    seller: { type: "string", description: "Address paid on release." },
    amount: { type: "string", description: 'Human-readable decimal, e.g. "5.00".' },
    walletId: { type: "string", description: "Optional: an Agent Wallet address (yours) to fund the escrow gaslessly; the server signs the lock for it." },
    arbiter: { type: "string", description: "Optional neutral third party who can resolve a dispute (not buyer/seller)." },
    memo: { type: "string" }, releaseDays: { type: "number", description: "Days until the buyer can timeout-refund (default 7, max 90)." },
  }, required: ["chain", "token", "seller", "amount"], additionalProperties: false },
} as const;

export const ESCROW_STATUS_TOOL = {
  name: "q402_escrow_status",
  description: "Read a Q402 escrow's current state (pending/open/disputed/released/refunded/expired) + parties, amount, and tx hashes.",
  inputSchema: { type: "object" as const, properties: idProp, required: ["escrowId"], additionalProperties: false },
} as const;

export const ESCROW_LOCK_TOOL = {
  name: "q402_escrow_lock",
  description:
    "Fund a pending escrow: the BUYER gaslessly locks the amount into the vault via EIP-7702 (Q402 relays + sponsors gas). MOVES REAL FUNDS. " +
    "If the escrow is funded by an Agent Wallet (created with walletId), the server signs it for you - no local key needed. Otherwise requires Q402_PRIVATE_KEY = the buyer's key. " +
    "ALWAYS confirm the exact amount/seller/chain with the user before calling (confirm:true).",
  inputSchema: { type: "object" as const, properties: { ...idProp, ...confirmProp }, required: ["escrowId", "confirm"], additionalProperties: false },
} as const;

export const ESCROW_RELEASE_TOOL = {
  name: "q402_escrow_release",
  description: "BUYER releases a locked escrow to the SELLER (buyer-signed, gasless). MOVES REAL FUNDS irreversibly. Confirm with the user first (confirm:true).",
  inputSchema: { type: "object" as const, properties: { ...idProp, ...confirmProp }, required: ["escrowId", "confirm"], additionalProperties: false },
} as const;

export const ESCROW_REFUND_TOOL = {
  name: "q402_escrow_refund",
  description: "Permissionlessly refund a locked escrow to the BUYER - only valid AFTER the release deadline (or, if disputed, after the arbiter resolve window). Confirm with the user first (confirm:true).",
  inputSchema: { type: "object" as const, properties: { ...idProp, ...confirmProp }, required: ["escrowId", "confirm"], additionalProperties: false },
} as const;

export const ESCROW_DISPUTE_TOOL = {
  name: "q402_escrow_dispute",
  description: "A party (buyer or seller) disputes an open escrow (requires the escrow named an arbiter, before the release deadline). The arbiter then resolves off-tool. Confirm with the user first (confirm:true).",
  inputSchema: { type: "object" as const, properties: { ...idProp, ...confirmProp }, required: ["escrowId", "confirm"], additionalProperties: false },
} as const;
