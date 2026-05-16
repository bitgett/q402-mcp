# @quackai/q402-mcp

> MCP server for Q402 — gasless USDC, USDT, and RLUSD payments across 7 EVM chains, callable directly from Claude Desktop and any other Model Context Protocol client.

[![npm](https://img.shields.io/npm/v/@quackai/q402-mcp.svg)](https://www.npmjs.com/package/@quackai/q402-mcp)
[![license](https://img.shields.io/npm/l/@quackai/q402-mcp.svg)](./LICENSE)

> **🎟️ Free trial available (2026-05-19 → 2026-06-30)** — 2,000 gasless transactions on BNB Chain (USDC + USDT), 30-day window, no card. One wallet signature: <https://q402.quackai.ai>.
>
> **Trial-scope policy:** API keys minted under the free-trial program (`plan: "trial"`) are restricted to BNB Chain with USDC/USDT — server-side enforcement, returns `403 TRIAL_BNB_ONLY` otherwise. **Paid API keys see the full 7-chain matrix at all times.**

Claude can now reason about stablecoin payments end to end — quote a transfer across 7 chains, pick the cheapest route, and (optionally) settle the transaction over [Q402](https://q402.quackai.ai)'s EIP-7702 relayer infrastructure. The recipient receives the full amount; the sender pays $0 in gas.

---

## Quick start (Claude Desktop)

```bash
claude mcp add q402 -- npx -y @quackai/q402-mcp
```

Or, if you prefer editing the config file directly, add this entry to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "q402": {
      "command": "npx",
      "args": ["-y", "@quackai/q402-mcp"]
    }
  }
}
```

Restart Claude Desktop and ask:

> *"Compare gas costs to send 50 USDC to vitalik.eth across all 7 Q402 chains."*

You'll get a ranked breakdown immediately — no API key, no signup, no funds at risk.

---

## Tools exposed

| Tool | Auth | Purpose |
|---|---|---|
| `q402_quote` | none | Compare gas cost and supported tokens across chains. Read-only. |
| `q402_balance` | API key | Verify the API key and report its plan tier + remaining quota credits (live vs sandbox). |
| `q402_pay` | API key + private key + flag | Send a gasless payment to a single recipient. **Sandbox by default** — see [Sandbox vs live mode](#sandbox-vs-live-mode). |
| `q402_batch_pay` | API key + private key + flag | Send a gasless payment to **multiple** recipients in one call on a single chain × token. Trial keys: 5 rows max. Paid keys: 20 rows max. Same sandbox gating as `q402_pay`. |
| `q402_receipt` | none | Look up a Trust Receipt by `rct_…` id and locally verify its ECDSA signature against the relayer EOA. Returns the public settlement record + a `verified` boolean. *receiptId-only today; tx-hash lookup reserved for a future release.* |

`q402_pay` and `q402_batch_pay` follow a "confirm in chat first" contract: the tool description instructs the model to never call it without explicit user approval of the recipient address(es), amount(s), chain, and token. For batch calls the user must approve the **full batch**, not the individual rows.

`q402_receipt` is the natural follow-up: after `q402_pay` returns a `receiptUrl`, hand the agent the `rct_…` id and ask *"verify this receipt"* — the tool re-runs the same canonical-JSON + EIP-191 recovery the receipt page does in the browser, so the verification doesn't depend on trusting any UI. Example prompts that work today:

> *"Pay 0.10 USDT on BNB to vitalik.eth, then verify the receipt."*  
> *"Is `rct_afa5f50bc49a65ebba3b28ab` a real Q402 receipt? Verify the signature."*

> Per-chain gas tank balances and full transaction history live in the [dashboard](https://q402.quackai.ai/dashboard) — those endpoints require a wallet signature, not a bare API key, so the MCP server points the agent there instead of exposing them.

---

## Sandbox vs live mode

By default the MCP server operates in **sandbox mode**: `q402_pay` returns a deterministic-looking fake transaction hash, no funds move, no gas-tank credit is consumed. That makes it safe to plug into any Claude Desktop install without worrying about an LLM hallucinating a payment.

To enable real on-chain transactions, **all three** environment variables must be set:

```bash
Q402_API_KEY=q402_live_...           # live-tier key from /dashboard
Q402_PRIVATE_KEY=0xabc...            # signer for the payer EOA
Q402_ENABLE_REAL_PAYMENTS=1          # explicit opt-in
```

Anything missing → automatic sandbox fallback with a hint pointing at what to set.

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
| `Q402_API_KEY` | balance, live-pay | Issue at https://q402.quackai.ai/dashboard. `q402_test_*` keys keep sandbox on. |
| `Q402_PRIVATE_KEY` | live-pay | Signer for the payer EOA. **Never share. Never paste in chat.** |
| `Q402_ENABLE_REAL_PAYMENTS` | live-pay | Set to `1` to opt in. Any other value (or unset) → sandbox. |
| `Q402_MAX_AMOUNT_PER_CALL` | optional | USD-equivalent cap. Defaults to `5`. |
| `Q402_ALLOWED_RECIPIENTS` | optional | Comma-separated lowercase addresses. Defaults to no allowlist. |
| `Q402_RELAY_BASE_URL` | optional | Defaults to `https://q402.quackai.ai/api`. Override for self-hosted Q402. |

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

---

## Why this exists

x402 standardised "402 Payment Required" semantics for AI agents but the official Coinbase facilitator only covers a few chains and assumes ERC-3009 token support — which excludes BNB USDT, Mantle USDT0, Injective USDT, and the chains where most stablecoin volume actually lives.

Q402 implements the same payer experience (single signature, $0 gas, instant settlement) on all 7 of those chains using EIP-7702 delegated execution, which works with any ERC-20. This MCP server makes that infrastructure addressable from Claude itself.

If you want to dig into how the wire protocol differs from x402, see [Q402 docs](https://q402.quackai.ai/docs).

---

## Repository

Source code: https://github.com/bitgett/q402-mcp
Issues / requests: https://github.com/bitgett/q402-mcp/issues

## License

Apache-2.0 — see [LICENSE](./LICENSE).
