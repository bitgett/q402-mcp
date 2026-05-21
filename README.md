# @quackai/q402-mcp

> MCP server for Q402 — gasless USDC, USDT, and RLUSD payments across 9 EVM chains, callable from Claude (Desktop / Code), OpenAI Codex CLI, and any other Model Context Protocol client.

[![npm](https://img.shields.io/npm/v/@quackai/q402-mcp.svg)](https://www.npmjs.com/package/@quackai/q402-mcp)
[![license](https://img.shields.io/npm/l/@quackai/q402-mcp.svg)](./LICENSE)

> **🎟️ Free trial available (2026-05-19 → 2026-06-30)** — 2,000 gasless transactions on BNB Chain (USDC + USDT), 30-day window, no card. One wallet signature: <https://q402.quackai.ai>.
>
> **Trial-scope policy:** API keys minted under the free-trial program (`plan: "trial"`) are restricted to BNB Chain with USDC/USDT — server-side enforcement, returns `403 TRIAL_BNB_ONLY` otherwise. **Paid API keys see the full 9-chain matrix at all times.**

AI agents — Claude (Desktop / Code), OpenAI Codex CLI, Cursor, Cline, and any other MCP-compatible client — can now reason about stablecoin payments end to end: quote a transfer across 9 chains, pick the cheapest route, and (optionally) settle the transaction over [Q402](https://q402.quackai.ai)'s EIP-7702 relayer infrastructure. The recipient receives the full amount; the sender pays $0 in gas.

---

## Quick start

Two steps:

1. Register the MCP server with your client (one-line install per client).
2. Open your client and say: **"Set up Q402"**. The agent calls `q402_doctor` which walks you through creating a single secrets file at `~/.q402/mcp.env` and pasting in your API key + private key. Nothing else.

### 1. Register the server

| Client | Command / config |
|---|---|
| **Claude Desktop / Claude Code** | `claude mcp add q402 -- npx -y @quackai/q402-mcp` |
| **OpenAI Codex CLI** | `codex mcp add q402 -- npx -y @quackai/q402-mcp` |
| **Cursor** | Add to `~/.cursor/mcp.json`: `{ "mcpServers": { "q402": { "command": "npx", "args": ["-y", "@quackai/q402-mcp"] } } }` |
| **Cline** | Cline → Settings → MCP Servers → Edit JSON. Same shape as Cursor. |
| **Any other stdio MCP client** | Point it at `npx -y @quackai/q402-mcp`. No client-specific code. |

That's it — secrets are NOT configured here. The MCP server reads them from `~/.q402/mcp.env` at startup (same pattern as AWS CLI / Stripe CLI / gh CLI), so every client uses the same file with no per-client wiring.

### 2. First-time setup

Restart your client, then ask your agent:

> *"Set up Q402"*

The agent calls `q402_doctor`. On first install, the tool tells the agent to:

1. Offer to create `~/.q402/mcp.env` (placeholder values only)
2. Open the file in your editor (`code` / `open` / `start` / `xdg-open`)
3. Walk you through pasting in (a) your API key from <https://q402.quackai.ai/event> (free Trial) or <https://q402.quackai.ai/payment> (paid Multichain), and (b) your wallet private key — **into the file, not into chat**
4. Restart the client and run `q402_doctor` again to verify

🔒 **Q402 never asks you to paste your private key into chat.** The MCP server signs payments LOCALLY on your machine — your key never leaves your device.

### Manual setup (no AI)

Create `~/.q402/mcp.env` yourself. The template below matches what `q402_doctor` writes — every secret line is commented out and `Q402_ENABLE_REAL_PAYMENTS` defaults to `0`. Uncomment the lines you need, paste real values, then flip the live flag to `1`. (Saving the template as-is is safe: invalid placeholders won't trip live mode.)

```bash
# ~/.q402/mcp.env

# Free Trial — BNB only, 2,000 sponsored TX (from /event)
# Q402_TRIAL_API_KEY=q402_live_...

# Paid Multichain — all 9 chains (from /payment)
# Q402_MULTICHAIN_API_KEY=q402_live_...

# Hex EVM private key (0x + 64 hex). Use a FRESH wallet, NOT your main
# one — Q402 delegates this EOA via EIP-7702 on first payment.
# Hardware wallets (Ledger / Trezor) are not supported yet.
# Q402_PRIVATE_KEY=0x...

# Start at 0 (sandbox). Flip to 1 only after real values are pasted above.
Q402_ENABLE_REAL_PAYMENTS=0

# Default Q402 deployment. Only change for self-hosted.
Q402_RELAY_BASE_URL=https://q402.quackai.ai/api

# Optional safety guards:
# Q402_MAX_AMOUNT_PER_CALL=5
# Q402_ALLOWED_RECIPIENTS=0xabc...,0xdef...
```

Then `chmod 600 ~/.q402/mcp.env` (Unix) and restart your client. That's the full configuration. **Heads up on the EIP-7702 side effect:** after your first live payment on a chain, your wallet will show 'Smart account' in MetaMask / OKX — that's the delegation Q402 uses for gasless settlement, reversible anytime via `q402_clear_delegation`.

### Advanced — explicit env injection

If you'd rather skip the file and inject env vars yourself (e.g. via Codex `env_vars` allow-list, a secrets manager, or shell exports), the server falls through to `process.env` — and `process.env` wins over file values on conflicts. So existing shell-export setups keep working unchanged.

<details>
<summary>Codex <code>env_vars</code> allow-list example</summary>

```toml
[mcp_servers.q402]
command = "npx"
args = ["-y", "@quackai/q402-mcp"]
startup_timeout_sec = 20.0
env_vars = [
  "Q402_TRIAL_API_KEY",
  "Q402_MULTICHAIN_API_KEY",
  "Q402_PRIVATE_KEY",
  "Q402_ENABLE_REAL_PAYMENTS",
  "Q402_RELAY_BASE_URL",
]
```

Then export the values in `~/.zshrc` / `~/.bashrc`. See the [Codex config reference](https://developers.openai.com/codex/config-reference) for the full schema.

</details>

### Try it without any setup

`q402_quote` works with zero configuration — no API key, no private key, no env file. Ask:

> *"Compare gas costs to send 50 USDC to vitalik.eth across all 9 Q402 chains."*

---

> `Q402_RELAY_BASE_URL` overrides the relay endpoint. Set it explicitly when running against a self-hosted Q402 deployment or a non-canonical environment.

---

## Tools exposed

| Tool | Auth | Purpose |
|---|---|---|
| `q402_doctor` | none | Health check covering BOTH first-install onboarding AND ongoing operational diagnostics. AI calls this when the user says "set up Q402" / "verify Q402" / "why isn't Q402 working". On first install, returns a `recommendedActions[]` payload telling the client to create `~/.q402/mcp.env` and open it in the user's editor. Later phases verify per-scope quota, EIP-7702 delegation state per chain, relay reachability, and surface slot-mismatch warnings (e.g. Trial-tier key sitting in `Q402_MULTICHAIN_API_KEY` would silently burn paid quota). Read-only — no signing, no on-chain action. |
| `q402_quote` | none | Compare gas cost and supported tokens across chains. Read-only. |
| `q402_balance` | API key | Verify the API key and report its plan tier + remaining quota credits (live vs sandbox). |
| `q402_pay` | API key + private key + flag | Send a gasless payment to a single recipient. **Sandbox by default** — see [Sandbox vs live mode](#sandbox-vs-live-mode). |
| `q402_batch_pay` | API key + private key + flag | Send a gasless payment to **multiple** recipients in one call on a single chain × token. Trial keys: 5 rows max. Paid keys: 20 rows max. **Auto-routing:** same rule as `q402_pay` (BNB + Trial key set ⇒ Trial, else Multichain). **Ambiguity gate:** 6+ recipient BNB batches with Trial set return `status="ambiguous"` instead of executing — the agent asks the user to pick `keyScope="trial"` (first 5), `"multichain"` (all paid), or two calls (5 free + remainder paid). **Supported chains: avax, bnb, eth, mantle, injective, monad, scroll** (default EIP-7702 mode). xlayer + stable are NOT batchable — use `q402_pay` in a loop for those. Same sandbox gating as `q402_pay`. **Rate-limit note:** the inner `/api/relay` budget (30/min per key) is consumed per row, so a paid 20-row batch leaves ~10 inner slots for the next minute. |
| `q402_receipt` | none | Look up a Trust Receipt by `rct_…` id and locally verify its ECDSA signature against the relayer EOA. Returns the public settlement record + a `verified` boolean. *receiptId-only today; tx-hash lookup reserved for a future release.* |
| `q402_wallet_status` | private key | Per-chain EIP-7702 delegation status for the EOA derived from `Q402_PRIVATE_KEY`, across all 9 Q402 chains. Read-only — no on-chain action, no quota consumption. Useful as the diagnostic step before `q402_clear_delegation`. |
| `q402_clear_delegation` | private key | Clear the EIP-7702 delegation on a single chain for the configured wallet. Local signing with `Q402_PRIVATE_KEY`; Q402 sponsors the on-chain TX so the user pays $0 gas. After clearing, the next `q402_pay` on that chain recreates a fresh delegation automatically. |

`q402_pay` and `q402_batch_pay` follow a "confirm in chat first" contract: the tool description instructs the model to never call it without explicit user approval of the recipient address(es), amount(s), chain, and token. For batch calls the user must approve the **full batch**, not the individual rows.

`q402_receipt` is the natural follow-up: after `q402_pay` returns a `receiptUrl`, hand the agent the `rct_…` id and ask *"verify this receipt"* — the tool re-runs the same canonical-JSON + EIP-191 recovery the receipt page does in the browser, so the verification doesn't depend on trusting any UI. Example prompts that work today:

> *"Pay 0.10 USDT on BNB to vitalik.eth, then verify the receipt."*  
> *"Is `rct_afa5f50bc49a65ebba3b28ab` a real Q402 receipt? Verify the signature."*

> Per-chain gas tank balances and full transaction history live in the [dashboard](https://q402.quackai.ai/dashboard) — those endpoints require a wallet signature, not a bare API key, so the MCP server points the agent there instead of exposing them.

---

## Sandbox vs live mode

By default the MCP server operates in **sandbox mode**: `q402_pay` returns a random fake transaction hash (32-byte hex, no on-chain broadcast), no funds move, no gas-tank credit is consumed. That makes it safe to plug into any MCP client without worrying about an accidental payment — if the agent misreads the conversation and fires `q402_pay` before you intended, nothing moves.

To enable real on-chain transactions, the resolved API key must be live (`q402_live_*`), `Q402_PRIVATE_KEY` must be set, and `Q402_ENABLE_REAL_PAYMENTS=1`:

```bash
# Two-key model — set whichever applies (or both for auto-routing).
# Auto-routing (same for q402_pay AND q402_batch_pay):
#   chain="bnb" + Q402_TRIAL_API_KEY set  → Trial (free sponsored)
#   anything else                          → Multichain (paid 9-chain)
# Batch ambiguity: 6+ recipient BNB batch with Trial set returns
#   status="ambiguous" instead of executing — agent asks user to pick.
# Override per call with keyScope: "auto" | "trial" | "multichain".
Q402_TRIAL_API_KEY=q402_live_...           # BNB-only sponsored Trial key (from /event)
Q402_MULTICHAIN_API_KEY=q402_live_...      # paid 9-chain key (per-chain Gas Tank)

Q402_PRIVATE_KEY=0xabc...                  # signer for the payer EOA
Q402_ENABLE_REAL_PAYMENTS=1                # explicit opt-in
```

Anything missing for the resolved scope → automatic sandbox fallback with a hint pointing at what to set.

> ⚠️ **Sandbox returns a deterministic-looking fake `txHash` and a synthetic success result.** A user who *expected* a live transfer (e.g. forgot to set `Q402_ENABLE_REAL_PAYMENTS=1`, mis-typed a scoped env var, or hit an impossible chain×scope combination like `keyScope: "trial"` + `chain: "monad"`) gets a "success" back and may believe funds actually moved.
>
> Two-layer mitigation: every sandbox response carries a `setupHint` field on the tool result describing **exactly why** sandbox was selected, and a `method: "sandbox"` field that makes the mode explicit independent of hash inspection. The `txHash` itself is a 32-byte random hex string — visually indistinguishable from a real hash but emitted only when no on-chain TX is broadcast — so don't rely on hash forensics. Always check `setupHint` (or `method`) before showing the user a success message.

### Hard caps

Two additional guards run before every payment regardless of mode:

| Env var | Default | Effect |
|---|---|---|
| `Q402_MAX_AMOUNT_PER_CALL` | `5` | Reject any single call where `amount > N` USD-equivalent. |
| `Q402_ALLOWED_RECIPIENTS` | (empty = off) | Comma-separated address allowlist. When set, all other recipients are rejected. |

Combined with the `confirm: true` argument the tool requires, this means the model needs (a) explicit user OK in chat, (b) amount ≤ cap, (c) recipient on allowlist if one exists, (d) all three live-mode env vars set, before a single wei moves.

---

## Configuration reference

| Env var | Required for | Notes |
|---|---|---|
| `Q402_TRIAL_API_KEY` | live-pay (BNB) | BNB-only sponsored Trial key. Free at https://q402.quackai.ai/event. Auto-routed for `chain="bnb"` in both `q402_pay` and `q402_batch_pay` (≤5 recipients) when set. 6+ recipient BNB batches return `status="ambiguous"` so the agent can ask the user how to split. |
| `Q402_MULTICHAIN_API_KEY` | live-pay (9-chain) | Paid 9-chain key. Get one at https://q402.quackai.ai/payment. Auto-routed for non-BNB chains AND for BNB when no Trial key is set. Cap: 20 recipients per batch. |
| `Q402_PRIVATE_KEY` | live-pay | Signer for the payer EOA. **Never share. Never paste in chat.** |
| `Q402_ENABLE_REAL_PAYMENTS` | live-pay | Set to `1` to opt in. Any other value (or unset) → sandbox. |
| `Q402_MAX_AMOUNT_PER_CALL` | optional | USD-equivalent cap. Defaults to `5`. |
| `Q402_ALLOWED_RECIPIENTS` | optional | Comma-separated lowercase addresses. Defaults to no allowlist. |
| `Q402_RELAY_BASE_URL` | optional | Defaults to `https://q402.quackai.ai/api`. Override for self-hosted Q402. |

> Older integrations may still set `Q402_API_KEY` as a single-env fallback — that still works silently for back-compat. New setups should use the two-key model above; `q402_doctor` only guides users to those two.

---

## Supported chains

| Chain | Chain ID | Token(s) | Notes |
|---|---|---|---|
| BNB Chain | 56 | USDC, USDT | |
| Ethereum | 1 | USDC, USDT, **RLUSD** | L1 — gas is volatile, quote is a snapshot. RLUSD (Ripple USD, NY DFS regulated, decimals 18) Ethereum-only. |
| Avalanche C-Chain | 43114 | USDC, USDT | |
| X Layer | 196 | USDC, USDT | |
| Stable | 988 | USDT0 (USDC and USDT both alias) | Gas paid in USDT0. |
| Mantle | 5000 | USDC, USDT0 | LayerZero OFT USDT0 since 2025-11-27. |
| Injective EVM | 1776 | USDT only | Native USDC via Circle CCTP announced for Q2 2026. |
| Monad | 143 | USDC, USDT0 | Native Circle USDC (CCTP V2) + USDT0 (LayerZero OFT). |
| Scroll | 534352 | USDC, USDT | zkEVM L2 — EIP-7702 live since the Euclid Phase 2 upgrade (2025-04-22). |

---

## Why this exists

AI agents are becoming the default interface for software, but the moment they need to move money the stack breaks: holding gas tokens, signing every transaction, managing wallets across many chains. None of that scales when the agent is supposed to act on its own.

Q402 is the payment layer for that gap. A single signing primitive (EIP-712 + EIP-7702) settles gasless stablecoin payments across 9 EVM chains, with an ECDSA-signed Trust Receipt for every transaction. The MCP package exposes that surface inside Claude, Codex, Cursor, and Cline — your agent can quote, send, batch, and audit payments from a natural-language prompt.

Single transfers and multi-recipient batches ship today. The next layer — recurring payouts, conditional execution, and policy-gated treasury automation — is the same primitive composed differently. We're building toward agents that operate real budgets, settle among themselves, and move value through workflows no human triggers manually.

---

## Repository

Source code: https://github.com/bitgett/q402-mcp
Issues / requests: https://github.com/bitgett/q402-mcp/issues

## License

Apache-2.0 — see [LICENSE](./LICENSE).
