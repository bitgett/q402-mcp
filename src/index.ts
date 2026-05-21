/**
 * @quackai/q402-mcp — MCP server entry point (stdio transport).
 *
 * Exposes eight tools to any MCP-compatible AI client (Claude Desktop,
 * Claude Code, OpenAI Codex CLI, Cursor, Cline, …):
 *
 *   q402_doctor             read-only, no key — first-install onboarding +
 *                           ongoing health check. AI calls this BEFORE pay /
 *                           balance whenever the user mentions setup or "is
 *                           Q402 working". Returns recommendedActions[] for
 *                           creating ~/.q402/mcp.env on first install.
 *   q402_quote              read-only, no key, no funds — gas comparison
 *   q402_balance            read-only, requires key — verify + remaining quota
 *   q402_pay                single-recipient settlement. Sandbox-default — real
 *                           TX only when API key (live tier), private key, and
 *                           Q402_ENABLE_REAL_PAYMENTS=1 all set
 *   q402_batch_pay          multi-recipient settlement (trial: 5 / paid: 20 per
 *                           call). Same chain + token across all recipients.
 *                           Same sandbox gating as q402_pay
 *   q402_receipt            read-only, no key — fetch + locally verify a Trust
 *                           Receipt
 *   q402_wallet_status      read-only, requires key — per-chain EIP-7702
 *                           delegation state across all 9 chains
 *   q402_clear_delegation   write, requires key — clears the EIP-7702
 *                           delegation on a chain (Q402-sponsored gas, local
 *                           signing)
 *
 * Trial-scope policy (server-enforced via API key plan): trial keys are
 * restricted to BNB Chain + USDC/USDT and capped at 5 recipients per
 * batch. Paid keys get the full 9-chain surface and 20-recipient batches.
 *
 * Configuration is read from `~/.q402/mcp.env` (created by q402_doctor
 * on first install) AND from `process.env` (process.env wins on
 * conflict). See README for the full env reference and the layered
 * security story behind the file-based default.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { CONFIG } from "./config.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.js";
import { QUOTE_TOOL, QuoteInputSchema, runQuote } from "./tools/quote.js";
import { PAY_TOOL, PayInputSchema, runPay } from "./tools/pay.js";
import { BATCH_PAY_TOOL, BatchPayInputSchema, runBatchPay } from "./tools/batch-pay.js";
import { BALANCE_TOOL, BalanceInputSchema, runBalance } from "./tools/balance.js";
import { RECEIPT_TOOL, ReceiptInputSchema, runReceipt } from "./tools/receipt.js";
import { WALLET_STATUS_TOOL, WalletStatusInputSchema, runWalletStatus } from "./tools/wallet-status.js";
import {
  CLEAR_DELEGATION_TOOL,
  ClearDelegationInputSchema,
  runClearDelegation,
} from "./tools/clear-delegation.js";
import { DOCTOR_TOOL, DoctorInputSchema, runDoctor } from "./tools/doctor.js";

function jsonText(value: unknown): { type: "text"; text: string } {
  return { type: "text", text: JSON.stringify(value, null, 2) };
}

async function main(): Promise<void> {
  const server = new Server(
    { name: PACKAGE_NAME, version: PACKAGE_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      // doctor first — it's the bootstrap tool: any "set up Q402" / "is Q402
      // working" prompt should land here before quote/balance/pay are tried.
      DOCTOR_TOOL,
      QUOTE_TOOL,
      BALANCE_TOOL,
      PAY_TOOL,
      BATCH_PAY_TOOL,
      RECEIPT_TOOL,
      WALLET_STATUS_TOOL,
      CLEAR_DELEGATION_TOOL,
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async req => {
    const { name, arguments: args } = req.params;
    try {
      switch (name) {
        case "q402_doctor": {
          DoctorInputSchema.parse(args ?? {});
          return { content: [jsonText(await runDoctor())] };
        }
        case "q402_quote": {
          const parsed = QuoteInputSchema.parse(args ?? {});
          return { content: [jsonText(runQuote(parsed))] };
        }
        case "q402_balance": {
          BalanceInputSchema.parse(args ?? {});
          return { content: [jsonText(await runBalance())] };
        }
        case "q402_pay": {
          const parsed = PayInputSchema.parse(args ?? {});
          return { content: [jsonText(await runPay(parsed))] };
        }
        case "q402_batch_pay": {
          const parsed = BatchPayInputSchema.parse(args ?? {});
          return { content: [jsonText(await runBatchPay(parsed))] };
        }
        case "q402_receipt": {
          const parsed = ReceiptInputSchema.parse(args ?? {});
          return { content: [jsonText(await runReceipt(parsed))] };
        }
        case "q402_wallet_status": {
          WalletStatusInputSchema.parse(args ?? {});
          return { content: [jsonText(await runWalletStatus())] };
        }
        case "q402_clear_delegation": {
          const parsed = ClearDelegationInputSchema.parse(args ?? {});
          return { content: [jsonText(await runClearDelegation(parsed))] };
        }
        default:
          return {
            isError: true,
            content: [jsonText({ error: `unknown tool: ${name}` })],
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [jsonText({ error: message, tool: name })],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Stdio MCP servers stay attached to the parent process; the transport keeps
  // the event loop alive until the host (Claude Desktop, Codex CLI, …) closes
  // the pipe.
  process.stderr.write(
    `${PACKAGE_NAME} v${PACKAGE_VERSION} ready (mode=${CONFIG.mode}, ` +
      `cap=$${CONFIG.maxAmountPerCallUsd}, allowlist=${CONFIG.allowedRecipients.length})\n`,
  );
}

main().catch(err => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
