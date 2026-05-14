/**
 * @quackai/q402-mcp — MCP server entry point (stdio transport).
 *
 * Exposes four tools to any MCP-compatible AI client (Claude Desktop, Claude
 * Code, Cline, …):
 *
 *   q402_quote    read-only, no key, no funds — gas comparison (BNB-focus
 *                 sprint: results restricted to BNB Chain + USDC/USDT)
 *   q402_balance  read-only, requires key — verify + remaining quota
 *   q402_pay      sandbox-default — real TX only when API key (live tier),
 *                 private key, and Q402_ENABLE_REAL_PAYMENTS=1 all set
 *                 (BNB-focus sprint: BNB Chain + USDC/USDT only)
 *   q402_receipt  read-only, no key — fetch + locally verify a Trust Receipt
 *
 * Configuration is environment-only (no on-disk state); see README for the
 * full env reference.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { CONFIG } from "./config.js";
import { QUOTE_TOOL, QuoteInputSchema, runQuote } from "./tools/quote.js";
import { PAY_TOOL, PayInputSchema, runPay } from "./tools/pay.js";
import { BALANCE_TOOL, BalanceInputSchema, runBalance } from "./tools/balance.js";
import { RECEIPT_TOOL, ReceiptInputSchema, runReceipt } from "./tools/receipt.js";

const PACKAGE_NAME = "@quackai/q402-mcp";
const PACKAGE_VERSION = "0.3.5";

function jsonText(value: unknown): { type: "text"; text: string } {
  return { type: "text", text: JSON.stringify(value, null, 2) };
}

async function main(): Promise<void> {
  const server = new Server(
    { name: PACKAGE_NAME, version: PACKAGE_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [QUOTE_TOOL, BALANCE_TOOL, PAY_TOOL, RECEIPT_TOOL],
  }));

  server.setRequestHandler(CallToolRequestSchema, async req => {
    const { name, arguments: args } = req.params;
    try {
      switch (name) {
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
        case "q402_receipt": {
          const parsed = ReceiptInputSchema.parse(args ?? {});
          return { content: [jsonText(await runReceipt(parsed))] };
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
  // the event loop alive until Claude Desktop closes the pipe.
  process.stderr.write(
    `${PACKAGE_NAME} v${PACKAGE_VERSION} ready (mode=${CONFIG.mode}, ` +
      `cap=$${CONFIG.maxAmountPerCallUsd}, allowlist=${CONFIG.allowedRecipients.length})\n`,
  );
}

main().catch(err => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
