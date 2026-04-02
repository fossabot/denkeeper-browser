/**
 * Denkeeper Browser MCP Server
 *
 * Wraps @playwright/mcp with custom text extraction tools:
 *   - browser_extract_text  (Readability + fallback)
 *   - browser_extract_html  (selector-based HTML extraction)
 *
 * All upstream Playwright MCP tools are proxied transparently.
 * Communicates via MCP stdio transport.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createConnection } from '@playwright/mcp';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { buildExtractScript, buildHtmlExtractScript } from './lib/extract.js';

// ---------------------------------------------------------------------------
// Readability source — loaded once at startup, injected into pages at runtime
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const readabilitySrc = readFileSync(
  join(__dirname, 'node_modules', '@mozilla', 'readability', 'Readability.js'),
  'utf-8',
);

// ---------------------------------------------------------------------------
// Custom tool definitions
// ---------------------------------------------------------------------------

const CUSTOM_TOOLS = [
  {
    name: 'browser_extract_text',
    description:
      'Extract readable text content from the current page using readability heuristics. ' +
      'Returns Markdown-formatted text with preserved structure (headings, lists, tables, links). ' +
      'Best tool for non-vision LLMs to understand page content.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector to scope extraction. Default: whole page.',
        },
        mode: {
          type: 'string',
          enum: ['readability', 'all', 'auto'],
          description:
            'Extraction mode. "readability": article-focused (Mozilla Readability). ' +
            '"all": all visible text. "auto" (default): try readability, fall back to all.',
        },
        include_forms: {
          type: 'boolean',
          description: 'Include form field descriptions (labels, types, values). Default: true.',
        },
        max_length: {
          type: 'number',
          description: 'Maximum content length in characters. Default: 16000.',
        },
      },
    },
  },
  {
    name: 'browser_extract_html',
    description:
      'Extract raw HTML from elements matching a CSS selector on the current page.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector for the element(s) to extract.',
        },
        outer: {
          type: 'boolean',
          description: 'Return outerHTML (true, default) or innerHTML (false).',
        },
      },
      required: ['selector'],
    },
  },
];

const CUSTOM_TOOL_NAMES = new Set(CUSTOM_TOOLS.map((t) => t.name));

// ---------------------------------------------------------------------------
// Find the evaluate tool name from upstream Playwright tools
// ---------------------------------------------------------------------------

function findEvalToolName(tools) {
  // Playwright MCP exposes an evaluate/execute tool — find it by name pattern.
  for (const t of tools) {
    if (
      t.name === 'browser_evaluate' ||
      t.name === 'browser_execute_javascript' ||
      t.name.includes('evaluate') ||
      t.name.includes('execute_javascript')
    ) {
      return t.name;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parse Playwright CLI flags from process.argv (passed by denkeeper)
// ---------------------------------------------------------------------------

function parseConfig() {
  const args = process.argv.slice(2);
  const config = {
    browser: {
      browserName: 'chromium',
      launchOptions: { headless: true },
    },
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--headless':
        config.browser.launchOptions.headless = true;
        break;
      case '--browser':
        if (args[i + 1]) config.browser.browserName = args[++i];
        break;
      case '--no-sandbox':
        config.browser.launchOptions.args =
          config.browser.launchOptions.args || [];
        config.browser.launchOptions.args.push('--no-sandbox');
        break;
      case '--user-data-dir':
        if (args[i + 1]) config.browser.userDataDir = args[++i];
        break;
    }
  }

  return config;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const config = parseConfig();

  // 1. Create the upstream Playwright MCP server
  const playwrightServer = await createConnection(config);

  // 2. Wire it to an in-memory transport so we can talk to it as a client
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await playwrightServer.connect(serverTransport);

  const playwrightClient = new Client(
    { name: 'denkeeper-browser-wrapper', version: '1.0.0' },
    { capabilities: {} },
  );
  await playwrightClient.connect(clientTransport);

  // 3. Discover upstream tools
  const { tools: upstreamTools } = await playwrightClient.listTools();
  const evalToolName = findEvalToolName(upstreamTools);

  if (!evalToolName) {
    console.error(
      'WARNING: no evaluate tool found in upstream Playwright MCP tools. ' +
        'Custom extraction tools will not work. Available tools: ' +
        upstreamTools.map((t) => t.name).join(', '),
    );
  }

  // 4. Create our wrapper MCP server
  const wrapperServer = new Server(
    { name: 'denkeeper-browser', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  // 5. Handle tools/list — merge upstream + custom
  wrapperServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...upstreamTools, ...CUSTOM_TOOLS],
  }));

  // 6. Handle tools/call — route to upstream or handle custom
  wrapperServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: toolArgs } = request.params;

    if (!CUSTOM_TOOL_NAMES.has(name)) {
      // Proxy to Playwright
      return await playwrightClient.callTool({
        name,
        arguments: toolArgs,
      });
    }

    // Handle custom tools
    if (!evalToolName) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error:
                'No evaluate tool available in upstream Playwright MCP server',
            }),
          },
        ],
      };
    }

    if (name === 'browser_extract_text') {
      return await handleExtractText(playwrightClient, evalToolName, toolArgs);
    }

    if (name === 'browser_extract_html') {
      return await handleExtractHtml(playwrightClient, evalToolName, toolArgs);
    }

    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'Unknown tool' }) }],
    };
  });

  // 7. Connect wrapper to stdio
  const stdioTransport = new StdioServerTransport();
  await wrapperServer.connect(stdioTransport);
}

// ---------------------------------------------------------------------------
// Custom tool handlers
// ---------------------------------------------------------------------------

async function handleExtractText(client, evalToolName, args) {
  const script = buildExtractScript(readabilitySrc, {
    selector: args?.selector || '',
    mode: args?.mode || 'auto',
    includeForms: args?.include_forms !== false,
    maxLength: args?.max_length || 16000,
  });

  try {
    const result = await client.callTool({
      name: evalToolName,
      arguments: { expression: script },
    });

    // The evaluate tool returns the result as text content.
    // Parse out the JSON string from the result.
    const text = extractTextFromResult(result);
    if (text) {
      try {
        // Validate it's valid JSON, then return it
        JSON.parse(text);
        return { content: [{ type: 'text', text }] };
      } catch {
        // Result wasn't valid JSON — return raw text
        return { content: [{ type: 'text', text }] };
      }
    }

    return {
      content: [
        { type: 'text', text: JSON.stringify({ error: 'Empty result from page evaluation' }) },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: 'Extraction failed: ' + (err.message || String(err)),
          }),
        },
      ],
    };
  }
}

async function handleExtractHtml(client, evalToolName, args) {
  if (!args?.selector) {
    return {
      content: [
        { type: 'text', text: JSON.stringify({ error: 'selector is required' }) },
      ],
    };
  }

  const script = buildHtmlExtractScript(args.selector, args?.outer !== false);

  try {
    const result = await client.callTool({
      name: evalToolName,
      arguments: { expression: script },
    });

    const text = extractTextFromResult(result);
    if (text) {
      return { content: [{ type: 'text', text }] };
    }

    return {
      content: [
        { type: 'text', text: JSON.stringify({ error: 'Empty result from page evaluation' }) },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: 'HTML extraction failed: ' + (err.message || String(err)),
          }),
        },
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the text content from an MCP tool result.
 * The evaluate tool typically returns { content: [{ type: 'text', text: '...' }] }.
 */
function extractTextFromResult(result) {
  if (!result?.content) return null;
  for (const block of result.content) {
    if (block.type === 'text' && block.text) {
      return block.text;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error('denkeeper-browser: fatal error:', err);
  process.exit(1);
});
