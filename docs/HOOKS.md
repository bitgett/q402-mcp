# Q402 Hooks 1.0

**A programmable policy engine for AI-agent payments.**

Uniswap v4 brought programmable hooks to DEX liquidity. Q402 brings them to
AI-agent payments. A Hook attaches to a point in the Q402 payment lifecycle
and either **gates** the payment (allow / deny / hold-for-approval) or
**transforms** it (split one intent into many). Every settlement still
produces a signed [Trust Receipt](#trust-receipts).

This document is the **developer contract**: the lifecycle, the types, the
shipped hooks, and how to configure them per Agent Wallet. The server-side
engine that runs these hooks is part of the Q402 relay and is not described
here — you interact with hooks through configuration and per-payment
parameters, not by deploying code.

---

## Lifecycle

A Q402 payment passes through three points. A hook is registered at exactly
one of them.

```
agent payment intent
        │
        ▼
 [ beforeAuthorize ]   ← gate the INTENT, before it becomes a signed authorization
        │  allow
        ▼
 [ beforeSettle ]      ← gate or TRANSFORM the settlement, before it fires on-chain
        │  allow
        ▼
   Q402 gasless settle  (EIP-7702 / EIP-712, relayer pays gas)
        │
        ▼
 [ afterSettle ]       ← side effects on the receipt (Trust Receipt is automatic here)
```

| Point | Use it for |
|---|---|
| `beforeAuthorize` | Checks that should block the **signature itself**, independent of balance — compliance screening, recipient allowlists, spend approvals. |
| `beforeSettle` | Checks that depend on the recipient or external state — reputation, oracle conditions — and **transforms** like multi-payee split. |
| `afterSettle` | Side effects once the payment confirms — the Trust Receipt is generated here automatically. |

---

## The contract

A hook returns one of four verdicts. The engine resolves a chain of hooks by
**precedence**: `deny` > `require_approval` > `split` > `allow`.

```ts
type HookLifecycle = "beforeAuthorize" | "beforeSettle" | "afterSettle";

interface HookContext {
  lifecycle:  HookLifecycle;
  owner:      string;   // the wallet owner's EOA (lowercased)
  walletId:   string;   // the Agent Wallet address (lowercased)
  chain:      string;   // "bnb" | "eth" | "avax" | ...
  token:      string;   // "USDC" | "USDT"
  recipient:  string;   // lowercased
  amount:     string;   // human-readable decimal, e.g. "1.50"
  amountUsd:  number;   // numeric convenience
  source:     "send" | "batch" | "bridge" | "recurring";
  params?:    HookParams;   // per-payment hook parameters (see below)
}

type HookOutcome =
  | { action: "allow" }
  | { action: "deny";             code: string; reason: string; status?: number; meta?: object }
  | { action: "require_approval"; code: string; reason: string; status?: number; meta?: object }
  | { action: "split";            parts: Array<{ recipient: string; amount: string }> };
```

- **`allow`** — proceed.
- **`deny`** — block hard. The route returns the hook's `status` (default `403`) and `code`.
- **`require_approval`** — a *soft* block: the payment does **not** settle;
  the route returns `202` with `{ "status": "approval_required", "code",
  "message" }`. Distinct from `deny` so the caller knows it's
  re-submittable rather than forbidden. **v1 does not store a pending
  request or expose an approve endpoint** — there is no automated resume.
  The caller (agent/UI) surfaces the hold and re-submits out of band once
  the payment is approved.
- **`split`** — replace the single settlement with N legs (beforeSettle only).

### Per-payment parameters

Some hooks read parameters attached to the specific payment:

```ts
interface HookParams {
  recipientAgentId?: string;          // ReputationGate — the recipient's ERC-8004 agent id
  condition?: {                       // ConditionalOracle — the gate condition
    kind: "price" | "timestamp";
    feed?: string;                    // e.g. "BTC/USD" (price only)
    op: ">=" | "<=" | ">" | "<" | "after" | "before";
    value: number;                    // USD price, or unix seconds
  };
  splits?: Array<{ recipient: string; bps: number }>;  // MultiPayeeSplit override
}
```

> **Trust boundary:** per-payment `params` are only honoured on the **Mode C**
> (API-key) path, where the key holder is the payment authority. On the
> owner-signature path they are ignored — only the wallet's stored config
> applies — because `params` are not part of the signed intent.

### Per-wallet configuration

Each Agent Wallet has a stored hook config (set via the dashboard or the
authenticated config API):

```ts
interface WalletHookConfig {
  reputationGate?: {
    enabled: boolean;
    minScore: number;                 // recipient's ERC-8004 score must meet this
    onUnknown: "allow" | "deny";      // when the recipient's agent id can't be verified
  };
  multiPayeeSplit?: {
    enabled: boolean;
    defaultSplits?: Array<{ recipient: string; bps: number }>;  // sum to 10000
  };
  spendCap?: {
    enabled: boolean;
    allowedRecipients?: string[];     // whitelist; unlisted recipient → deny
    allowedWindowsUtc?: Array<{ startHour: number; endHour: number }>;  // [start, end)
    perCallApprovalUsd?: number;      // amount ≥ this → require_approval
  };
}
```

ComplianceGate has **no** per-wallet config — it is global and always on.

---

## Shipped hooks

### ComplianceGate — `beforeAuthorize`, global

Screens every recipient against the OFAC sanctioned-address list. Not
opt-in; it covers every payment surface (`send`, `batch`, and the legs of a
split). A sanctioned recipient is denied with `451 Unavailable For Legal
Reasons` before any reservation is taken.

```jsonc
// no config — always on
```

### SpendCapPolicy — `beforeAuthorize`

Programmable spend rules layered on top of the Agent Wallet's native
per-transaction and daily limits (which are hard caps). Adds what native
caps lack:

```jsonc
{
  "spendCap": {
    "enabled": true,
    "allowedRecipients": ["0xabc...", "0xdef..."],     // unlisted → deny RECIPIENT_NOT_ALLOWED
    "allowedWindowsUtc": [{ "startHour": 9, "endHour": 17 }],  // outside → deny OUTSIDE_ALLOWED_WINDOW
    "perCallApprovalUsd": 100                          // amount ≥ $100 → require_approval
  }
}
```

`perCallApprovalUsd` is a **soft** cap — a payment at/above it is not
settled and returns `approval_required` (202) instead of a hard deny (the
difference from the native `perTxMaxUsd` ceiling). v1 surfaces the hold;
it does not store it or auto-resume (see `require_approval` above).

### ReputationGate — `beforeSettle`

"My agent only pays counterparties whose ERC-8004 reputation meets a
threshold." Only Q402 can offer this natively — it runs the ERC-8004
ReputationRegistry heartbeat and signs every settlement.

```jsonc
{
  "reputationGate": { "enabled": true, "minScore": 5, "onUnknown": "deny" }
}
```

```jsonc
// per-payment: declare which agent the recipient claims to be
{ "hookParams": { "recipientAgentId": "12345" } }
```

> **Anti-spoofing:** the gate verifies the claimed agent's **on-chain bound
> wallet** (`getAgentWallet`) equals the actual recipient before applying
> any reputation. A high-reputation agent id attached to a payment going
> elsewhere is hard-denied (`REPUTATION_RECIPIENT_MISMATCH`) — you cannot
> borrow another agent's score.

### ConditionalOracle — `beforeSettle`, Chainlink Data Feeds

Stablecoin limit orders: settle only when a price level or timestamp is met.
Q402's second Chainlink integration (CCIP being the first).

```jsonc
// "only settle when BTC/USD >= 80000"
{ "hookParams": { "condition": { "kind": "price", "feed": "BTC/USD", "op": ">=", "value": 80000 } } }

// "only settle after a unix timestamp"
{ "hookParams": { "condition": { "kind": "timestamp", "op": "after", "value": 1767225600 } } }
```

When the condition isn't met yet, the response is `412 Precondition Failed`
(`CONDITION_NOT_MET`) — an un-triggered limit order, distinct from an error,
so a client can poll. Price feeds are read from Chainlink, verified against
the feed's on-chain description, and rejected if stale. Supported price feeds:
`BTC/USD`, `ETH/USD` on `bnb` / `eth` / `avax` / `arbitrum`.

### MultiPayeeSplit — `beforeSettle` (transform)

One intent → automatic N-way fan-out (royalty / revenue-share / protocol fee).

```jsonc
{
  "multiPayeeSplit": {
    "enabled": true,
    "defaultSplits": [
      { "recipient": "0xRoyalty...", "bps": 7000 },   // 70%
      { "recipient": "0xRevenue...", "bps": 2500 },   // 25%
      { "recipient": "0xFee...",     "bps": 500 }     // 5%
    ]
  }
}
```

```jsonc
// per-payment override
{ "hookParams": { "splits": [{ "recipient": "0xA...", "bps": 9000 }, { "recipient": "0xB...", "bps": 1000 }] } }
```

Basis points must sum to `10000`. Leg amounts are computed in raw token units
so they sum to the original total to the wei — rounding dust is absorbed by
the last leg, so there's no under- or over-pay. Each leg is its own on-chain
settlement; a partial failure records the legs that landed and refunds the
unsettled portion. Every leg is screened by ComplianceGate.

---

## Trust Receipts

Every Q402 settlement — hooked or not — produces an ECDSA-signed Trust
Receipt (off-chain, gasless) keyed by the settlement tx hash. The receipt is
verifiable by anyone with the canonical fields and the relayer's signature.
This is the `afterSettle` side of the lifecycle and requires no
configuration.

---

## Behaviour summary

| Outcome | HTTP | Meaning |
|---|---|---|
| allow | 200 | settled |
| deny | 403 (451 for compliance, 412 for un-met condition) | blocked |
| require_approval | 202 `{ status: "approval_required" }` | not settled; re-submit out of band (no stored hold in v1) |
| split | 200 / 207 Multi-Status | fanned out (207 on partial) |

Precedence when multiple hooks fire: **deny > require_approval > split > allow**.

---

## Roadmap

Shipped in 1.0: ComplianceGate, SpendCapPolicy, ReputationGate,
ConditionalOracle, MultiPayeeSplit, Trust Receipts.

Planned: on-chain governance as a policy source (config moves from signed
JSON to a governance read with no hook-code change), LoyaltyMint
(`afterSettle` reward-token mint), and additional `afterSettle` actions.
