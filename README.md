# @quackai/q402-mcp

> MCP server for Q402 — gasless USDC, USDT, and RLUSD payments across 10 EVM chains, callable from Claude (Desktop / Code), OpenAI Codex CLI, and any other Model Context Protocol client.

[![npm](https://img.shields.io/npm/v/@quackai/q402-mcp.svg)](https://www.npmjs.com/package/@quackai/q402-mcp)
[![license](https://img.shields.io/npm/l/@quackai/q402-mcp.svg)](./LICENSE)

> **Free trial available (through 2026-06-30)** — 2,000 gasless transactions on BNB Chain (USDC + USDT), 30-day window, no card. One wallet signature: <https://q402.quackai.ai>.
>
> **Trial-scope policy:** API keys minted under the free-trial program (`plan: "trial"`) are restricted to BNB Chain with USDC/USDT — server-side enforcement, returns `403 TRIAL_BNB_ONLY` otherwise. **Paid API keys see the full 10-chain matrix at all times.**

Quote → route → (optional) settle stablecoin payments across 10 EVM chains, from any MCP client. Recipient gets the full amount; sender pays $0 gas via [Q402](https://q402.quackai.ai)'s EIP-7702 relayer.

---

## Quick start

1. Register the server with your client (one-line per client).
2. Say **"Set up Q402"** to your agent. It runs `q402_doctor` → creates `~/.q402/mcp.env` → walks you through pasting keys.

### 1. Register the server

| Client | Command / config |
|---|---|
| **Claude Code (CLI)** | `claude mcp add q402 -- npx -y @quackai/q402-mcp` |
| **Claude Desktop (app)** | Edit `claude_desktop_config.json` (Settings → Developer → Edit Config): `{ "mcpServers": { "q402": { "command": "npx", "args": ["-y", "@quackai/q402-mcp"] } } }`. Restart the app. |
| **OpenAI Codex CLI** | `codex mcp add q402 -- npx -y @quackai/q402-mcp` (Windows fallback: see below) |
| **Cursor** | Add to `~/.cursor/mcp.json`: `{ "mcpServers": { "q402": { "command": "npx", "args": ["-y", "@quackai/q402-mcp"] } } }` |
| **Cline** | Cline → Settings → MCP Servers → Edit JSON. Same shape as Cursor. |
| **Any other stdio MCP client** | Point it at `npx -y @quackai/q402-mcp`. No client-specific code. |

> Claude **Code** (the CLI, `claude` binary) and Claude **Desktop** (the macOS / Windows app) are different products. The `claude mcp add` command only exists in the CLI; the Desktop app needs the JSON config above.

Secrets are NOT in this config. The server reads them from `~/.q402/mcp.env` (same pattern as AWS / Stripe / gh CLIs).

<details>
<summary>Windows: <code>codex mcp add</code> returns "Access is denied"</summary>

Some Windows setups block `codex.exe` from writing its own config. Add the stanza to `~/.codex/config.toml` by hand:

```toml
[mcp_servers.q402]
command = "npx"
args = ["-y", "@quackai/q402-mcp"]
```

Then restart Codex. Same effect as `codex mcp add q402 -- npx -y @quackai/q402-mcp`.

</details>

### 2. First-time setup

Restart your client, ask: > *"Set up Q402"*

The agent runs `q402_doctor`. On first install:

1. Creates `~/.q402/mcp.env` (placeholders)
2. Opens it in your editor
3. Walks you through pasting an API key + a signing path **into the file, not into chat**
4. Restart + re-run `q402_doctor` to verify

🔒 **Keys never paste into chat.** Local modes sign on your machine; the key never leaves the device. Mode C (server-managed) needs no PK on the client.

### Pick a signing mode

| Mode | Env | Signer | Notes |
|---|---|---|---|
| **A** | `Q402_PRIVATE_KEY` | MetaMask EOA, local | Simplest. Shows "Smart account" after first use (reversible via `q402_clear_delegation`). |
| **B** | `Q402_AGENTIC_PRIVATE_KEY` | Agent Wallet, local | Export PK from the [dashboard](https://q402.quackai.ai/dashboard) → Wallets → Danger Zone → Export private key. MetaMask untouched. |
| **C** | (just an API key) | Agent Wallet, server-managed | No PK on the client. One-shot pays accept Trial or Multichain keys; recurring needs Multichain on every chain (BNB included). |

When more than one mode is set, `q402_pay` asks the user which to use. Picker: `walletMode = "agentic-server" \| "agentic-local" \| "eoa"`.

### Manual setup (no AI)

Create `~/.q402/mcp.env` yourself with the template below. Live mode only flips when an API key + a signing path are populated, so saving the template as-is stays in sandbox. `Q402_ENABLE_REAL_PAYMENTS=0` forces sandbox even with real keys.

```bash
# ~/.q402/mcp.env

# ── API key (pick one or both for auto-routing) ──
Q402_TRIAL_API_KEY=          # Free Trial, BNB only (from /event)
Q402_MULTICHAIN_API_KEY=     # Paid Multichain, all 10 chains (from /payment)

# ── Signing path — pick ONE of Mode A / B / C ──
# Mode A: your MetaMask EOA's hex private key.
# Hardware wallets (Ledger / Trezor) are NOT supported here — Q402
# needs a raw hex key it can sign EIP-7702 type-4 authorizations with.
Q402_PRIVATE_KEY=

# Mode B: exported Agent Wallet pk from the dashboard. Keeps your
# MetaMask untouched. Get it at:
#   https://q402.quackai.ai/dashboard → Agent tab → Export
Q402_AGENTIC_PRIVATE_KEY=

# Mode C: no PK needed. Set ONLY the paid Multichain key above, leave
# both PK lines blank. Q402 signs with the server-managed Agent Wallet.
# Optional: pin one of your Agent Wallets when you have multiple (max 10).
# Q402_AGENT_WALLET_ADDRESS=0x...

# Live mode switch:
#   0 = sandbox (test mode, no funds move)
#   1 = real on-chain payments
# Default 1 — safe because mode only flips to live when an API key AND
# at least one valid signing path (A/B/C) are populated above.
Q402_ENABLE_REAL_PAYMENTS=1

# Default Q402 deployment. Only change for self-hosted.
Q402_RELAY_BASE_URL=https://q402.quackai.ai/api

# Safety guards (max-amount ships uncommented at $200; lower for tighter caps):
Q402_MAX_AMOUNT_PER_CALL=200
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
  "Q402_AGENTIC_PRIVATE_KEY",
  "Q402_AGENT_WALLET_ADDRESS",
  "Q402_ENABLE_REAL_PAYMENTS",
  "Q402_RELAY_BASE_URL",
]
```

Then export the values in `~/.zshrc` / `~/.bashrc`. See the [Codex config reference](https://developers.openai.com/codex/config-reference) for the full schema.

</details>

### Try it without any setup

`q402_quote` works with zero configuration — no API key, no private key, no env file. Ask:

> *"Compare gas costs to send 50 USDC to vitalik.eth across all 10 Q402 chains."*

---

> `Q402_RELAY_BASE_URL` overrides the relay endpoint. Set it explicitly when running against a self-hosted Q402 deployment or a non-canonical environment.

---

## Tools exposed

**24 tools** — read-only by default; live mode needs an API key + signing path + `Q402_ENABLE_REAL_PAYMENTS=1`.

| Tool | Auth | Purpose |
|---|---|---|
| `q402_doctor` | none | First-install onboarding + ongoing health check (per-scope quota, EIP-7702 state, relay reachability, slot-mismatch warnings). |
| `q402_quote` | none | Compare gas + supported tokens across chains. |
| `q402_balance` | api key | Verify key + remaining quota. |
| `q402_pay` | live mode | Single-recipient gasless transfer. Sandbox by default. |
| `q402_batch_pay` | live mode | Up to 20 recipients per call (trial: 5). Same auto-routing as `q402_pay`. 6+ BNB batches with Trial set return `status="ambiguous"` so the agent asks how to split. xlayer + stable not batchable — use `q402_pay` in a loop. |
| `q402_receipt` | none | Fetch + locally verify a Trust Receipt (`rct_…` id, ECDSA against the relayer EOA). |
| `q402_wallet_status` | private key | Per-chain EIP-7702 state for the EOA derived from `Q402_PRIVATE_KEY`. |
| `q402_clear_delegation` | private key | Clear EIP-7702 delegation; Q402 sponsors the on-chain TX. |
| `q402_agentic_info` | api key | Agent Wallet info (addresses, per-wallet caps, daily-spend used, ERC-8004 id). Drives Mode C. |
| `q402_recurring_list` | api key | List scheduled rules. |
| `q402_recurring_create` | api key | Author a recurring rule. Paid Multichain on EVERY chain (BNB included). |
| `q402_recurring_fires` | api key | Last 50 fires per rule (timestamp + txHashes + amount). |
| `q402_recurring_pause` | api key | Pause a rule (reversible). |
| `q402_recurring_resume` | api key | Resume a paused / stopped rule. |
| `q402_recurring_skip_next` | api key | Skip only the next scheduled fire. |
| `q402_recurring_cancel` | api key | Permanently stop a rule. |
| `q402_bridge_quote` | none | Quote a Chainlink CCIP USDC bridge across eth/avax/arbitrum. Returns LINK + native fee. |
| `q402_bridge_send` | live mode | Execute a CCIP bridge from the user's Agent Wallet. Mode C only (server-managed). Sandbox-by-default; `sandbox: false` + live Multichain key + `Q402_ENABLE_REAL_PAYMENTS=1` fires a real on-chain bridge. |
| `q402_bridge_history` | not yet wired | Pointer to the dashboard. Returns `{ implemented: false, dashboardUrl, dashboardPath }` — read-only guidance until owner-sig auth lands in MCP. |
| `q402_bridge_gas_tank` | not yet wired | Static guidance + dashboard pointer for the Bridge Gas Tank top-up flow. Live balance lookup needs owner-sig auth (dashboard for now). |
| `q402_yield_reserves` | none | List Q402 Yield (Aave V3) lending markets — protocol, chain, asset, market address, supply APY. BNB Chain only today. |
| `q402_yield_positions` | api key | Show the Agent Wallet's open Q402 Yield positions (balance, principal, accrued interest, APY) + total supplied in USD. Mode C. |
| `q402_yield_deposit` | live mode | Supply the Agent Wallet's USDC/USDT into Aave V3 (Q402 Yield) to earn supply APY. Mode C, BNB-only. Requires `confirm: true`; sandbox-by-default. |
| `q402_yield_withdraw` | live mode | Withdraw supplied USDC/USDT out of Aave V3 back to the Agent Wallet (`amount: "max"` = full position). Mode C, BNB-only. Requires `confirm: true`; sandbox-by-default. |

`q402_pay` + `q402_batch_pay` + `q402_bridge_send` + `q402_yield_deposit` + `q402_yield_withdraw` require explicit in-chat confirmation. Batch confirmation = full batch, not per-row.

> ℹ️ `q402_pay` expects a 0x address — ENS isn't resolved server-side. Resolve client-side first.
> Per-chain Gas Tank balances + full TX history live in the [dashboard](https://q402.quackai.ai/dashboard) (wallet-signature only).

---

## Sandbox vs live mode

**Sandbox default**: `q402_pay` returns a fake `txHash` with `success: false` and `sandbox: true`. No funds, no quota.

**Live** = (a) live API key (`q402_live_*`), (b) a signing path (A / B / C), (c) `Q402_ENABLE_REAL_PAYMENTS=1`. The live flag defaults to `1` — gate only flips when both other conditions are met. Set to `0` to force sandbox even with real keys.

Template `q402_doctor` writes to `~/.q402/mcp.env`:

```bash
# ── API key — fill ONE (or both for auto-routing) ──
# Auto-routing (same for q402_pay AND q402_batch_pay):
#   chain="bnb" + Q402_TRIAL_API_KEY set  → Trial (free sponsored)
#   anything else                          → Multichain (paid 10-chain)
# Batch ambiguity: 6+ recipient BNB batch with Trial set returns
#   status="ambiguous" instead of executing — agent asks user to pick.
# Override per call with keyScope: "auto" | "trial" | "multichain".
Q402_TRIAL_API_KEY=                # BNB-only sponsored Trial key (from /event)
Q402_MULTICHAIN_API_KEY=           # paid 10-chain key (per-chain Gas Tank)

# ── Signing path — pick ONE of Mode A / B / C ──
Q402_PRIVATE_KEY=                  # Mode A: real EOA pk (0x + 64 hex)
Q402_AGENTIC_PRIVATE_KEY=          # Mode B: exported Agent Wallet pk (from dashboard)
# Mode C: leave both PK lines blank, set only the paid Multichain key
# above. Q402 signs with the server-managed Agent Wallet. Optionally:
# Q402_AGENT_WALLET_ADDRESS=0x...   # pin one of your wallets when you have multiple

# Live mode switch:
#   0 = sandbox (test mode, no funds move — every q402_pay returns a fake hash)
#   1 = real on-chain payments (live mode)
# Default 1. Safe because the gate only flips to live when an API key AND
# at least one valid signing path (A/B/C) are populated. Empty values
# fail the gate, so partial setups stay in sandbox with a hint.
Q402_ENABLE_REAL_PAYMENTS=1
```

Anything missing for the resolved scope → automatic sandbox fallback with a hint pointing at what to set.

> ⚠️ Sandbox responses carry `success: false`, `sandbox: true`, `mode: "sandbox"`, `method: "sandbox"`, plus a `setupHint` explaining why — four signals so a downstream summary can't claim success.

### Hard caps

| Env var | Default | Effect |
|---|---|---|
| `Q402_MAX_AMOUNT_PER_CALL` | `200` | Reject calls with `amount > N` USD. |
| `Q402_ALLOWED_RECIPIENTS` | off | Comma-separated address allowlist. |

Combined with `confirm: true` + live-mode env, a payment needs: chat OK + amount ≤ cap + recipient allowed + all 3 live envs.

---

## Configuration reference

| Env var | Required for | Notes |
|---|---|---|
| `Q402_TRIAL_API_KEY` | live-pay (BNB) | BNB-only sponsored Trial key. Free at https://q402.quackai.ai/event. Auto-routed for `chain="bnb"` in both `q402_pay` and `q402_batch_pay` (≤5 recipients) when set. 6+ recipient BNB batches return `status="ambiguous"` so the agent can ask the user how to split. |
| `Q402_MULTICHAIN_API_KEY` | live-pay (10-chain) | Paid 10-chain key. Get one at https://q402.quackai.ai/payment. Auto-routed for non-BNB chains AND for BNB when no Trial key is set. Cap: 20 recipients per batch. Required for Mode C (server-managed Agent Wallet). |
| `Q402_PRIVATE_KEY` | Mode A | Hex private key of your MetaMask EOA. Signer for local Mode A. **Never share. Never paste in chat.** |
| `Q402_AGENTIC_PRIVATE_KEY` | Mode B | Exported Agent Wallet hex private key from the dashboard (Agent tab → Export). Signs locally, but the signer is your dedicated Agent Wallet — MetaMask is never touched. **Never share. Never paste in chat.** |
| `Q402_AGENT_WALLET_ADDRESS` | Mode C (optional) | When you have multiple server-managed Agent Wallets (max 10 per owner), set this to the lowercased 0x… address of the one Q402 should spend from. Omit to use the default wallet. Ignored in Modes A/B. |
| `Q402_ENABLE_REAL_PAYMENTS` | live-pay | Set to `1` to opt in. Any other value (or unset) → sandbox. |
| `Q402_MAX_AMOUNT_PER_CALL` | optional | USD-equivalent cap. Defaults to `200`. Lower for tighter agent blast-radius. |
| `Q402_ALLOWED_RECIPIENTS` | optional | Comma-separated lowercase addresses. Defaults to no allowlist. |
| `Q402_RELAY_BASE_URL` | optional | Defaults to `https://q402.quackai.ai/api`. Override for self-hosted Q402. |

<details>
<summary>Migrating from legacy single-key setups</summary>

If you set up Q402 before v0.5.0 you may have a single `Q402_API_KEY` env var. The server still resolves that silently — your existing integration won't break. New installs should use the two-key model above (`Q402_TRIAL_API_KEY` and/or `Q402_MULTICHAIN_API_KEY`); `q402_doctor` and the rest of the docs only guide users to those two. To migrate, rename your existing var to `Q402_MULTICHAIN_API_KEY` in `~/.q402/mcp.env` and restart your MCP client.

</details>

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
| Injective EVM | 1776 | USDC, USDT | Native Circle USDC (CCTP) live since 2026-06 + canonical Tether (USDT0). |
| Monad | 143 | USDC, USDT0 | Native Circle USDC (CCTP V2) + USDT0 (LayerZero OFT). |
| Scroll | 534352 | USDC, USDT | zkEVM L2 — EIP-7702 live since the Euclid Phase 2 upgrade (2025-04-22). |
| Arbitrum One | 42161 | USDC, USDT | Optimistic rollup — same EIP-7702 signing path as Ethereum. CCIP bridge endpoint (eth ⇄ avax ⇄ arbitrum). |

---

## Why this exists

AI agents are becoming the default interface for software, but the moment they need to move money the stack breaks: holding gas tokens, signing every transaction, managing wallets across many chains. None of that scales when the agent is supposed to act on its own.

Q402 is the payment layer for that gap. A single signing primitive (EIP-712 + EIP-7702) settles gasless stablecoin payments across 10 EVM chains, with an ECDSA-signed Trust Receipt for every transaction. The MCP package exposes that surface inside Claude, Codex, Cursor, and Cline — your agent can quote, send, batch, and audit payments from a natural-language prompt.

Single transfers and multi-recipient batches ship today. The next layer — recurring payouts, conditional execution, and policy-gated treasury automation — is the same primitive composed differently. We're building toward agents that operate real budgets, settle among themselves, and move value through workflows no human triggers manually.

---

## Hooks — programmable payment policies

Q402 Hooks 1.0 is a policy engine that attaches rules to the payment lifecycle: OFAC compliance screening, spend caps + recipient allowlists, ERC-8004 reputation gating, Chainlink-oracle conditional settlement ("only when BTC ≥ $80k"), and automatic multi-payee splits — plus an approval-required soft block for large payments (returns 202 `approval_required`; the caller re-submits out of band, no stored hold in v1). Uniswap v4 brought programmable hooks to DEX liquidity; Q402 brings them to AI-agent payments.

**Developer reference: [docs/HOOKS.md](docs/HOOKS.md)** — lifecycle, the Hook contract, every shipped hook with config + examples.

---

## Repository

Source code: https://github.com/bitgett/q402-mcp
Issues / requests: https://github.com/bitgett/q402-mcp/issues

## License

Apache-2.0 — see [LICENSE](./LICENSE).
