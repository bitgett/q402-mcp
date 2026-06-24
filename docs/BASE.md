# Q402 on Base

Gasless x402 stablecoin payments for AI agents on **Base** (chainId 8453), delivered through this MCP server.

Q402 is x402-compatible, but settles **gaslessly** via EIP-7702: the payer's EOA delegates to the Q402 implementation contract, and the Q402 facilitator pays the gas. Because the gas sponsorship lives in the delegated contract rather than in the token, Q402 works with **USDC and USDT** on Base, not USDC only.

## Proven on Base mainnet

Real mainnet transactions (not testnet). Both moved 0.001 USDC, the recipient received the full amount, and the payer signed only an off-chain authorization (zero gas in the wallet):

| Rail | What it proves | Transaction |
|------|----------------|-------------|
| **x402** (EIP-3009) | Coinbase x402 standard, gasless settlement | [0x75c6d3a8...ab5cbde](https://basescan.org/tx/0x75c6d3a870bd1f6752bd597004aecccaf4130f8b0e15a219b007fe844ab5cbde) |
| **q402** (EIP-7702) | Set-code delegation, gasless settlement | [0xc2034668...d3b9ed](https://basescan.org/tx/0xc2034668a260526ef88ae3ab0d8d01bd82c62ea3c5136cbf0755dd1e87d3b9ed) |

## Contracts on Base

**Q402 implementation (verified on BaseScan):**
[0x2fb2B2D110b6c5664e701666B3741240242bf350](https://basescan.org/address/0x2fb2B2D110b6c5664e701666B3741240242bf350#code)

On-chain: `NAME() = "Q402 Base"`, `VERSION() = "1"`, owner-binding enforced (reverts `OwnerMismatch`).

**Stablecoins:**

| Token | Address |
|-------|---------|
| USDC (native Circle) | [0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913](https://basescan.org/token/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) |
| USDT (bridged) | [0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2](https://basescan.org/token/0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2) |

## Use it from any agent

Q402 ships as an MCP server, so any MCP client can pay, get paid, and (soon) earn yield on Base with zero gas in the wallet: Claude (Desktop / Code), OpenAI Codex CLI, Cursor, Cline, GitHub Copilot, Hermes (Nous), and others.

```
npx -y @quackai/q402-mcp
```

Per-client setup is in the main [README](../README.md).

## What runs on Base

| Capability | Status |
|------------|--------|
| Payments (send, batch, scheduled, invoices), USDC + USDT, gasless | Live |
| x402 (pay any x402 API with no gas, Coinbase standard, Base-native) | Live |
| Morpho yield (deposit / withdraw idle USDC into a Base Morpho MetaMorpho ERC-4626 vault, agent-driven). Off-chain path, MCP tools, and dashboard Earn selector are built; Base impl contract pending audit + owner approval before deploy. | Implemented (deploy pending) |

## Traction

About 100,000 settlements and 15,500 MCP downloads across 11 chains in roughly a month. Base is the newest chain.

## Links
- npm: https://www.npmjs.com/package/@quackai/q402-mcp
- Docs: https://q402.quackai.ai/docs
