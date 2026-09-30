// SPDX-License-Identifier: AGPL-3.0-only
// MCP over stdio, for a desktop MCP client that starts the server itself. It is a
// thin bridge to the clinic's HTTP /mcp server: it needs that address and an API key,
// and nothing else, never the database or the data key. stdout carries the protocol,
// so the log goes to stderr.
import { createLogger } from '@attendra/observability';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { bridge } from './bridge';
import { loadBridgeEnv } from './config';

const env = loadBridgeEnv();
const log = createLogger({ name: 'mcp', level: env.LOG_LEVEL, destination: process.stderr });
const remote = new StreamableHTTPClientTransport(new URL(env.ATTENDRA_MCP_URL), { requestInit: { headers: { authorization: `Bearer ${env.ATTENDRA_API_KEY}` } } });
await bridge(new StdioServerTransport(), remote, (err) => log.warn({ err: { name: err.name, code: (err as { code?: number }).code } }, 'mcp bridge request failed'));
log.info({ url: env.ATTENDRA_MCP_URL, key: env.ATTENDRA_API_KEY.slice(0, 12) }, 'mcp bridge on stdio');
