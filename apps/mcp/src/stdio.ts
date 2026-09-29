// SPDX-License-Identifier: AGPL-3.0-only
// MCP over stdio, for a client that starts the server itself (Claude Desktop and
// others). The key comes from ATTENDRA_API_KEY. stdout carries the protocol, so the
// log goes to stderr.
import { authenticateApiKey, connect, createPhiCipher } from '@attendra/db';
import { createLogger } from '@attendra/observability';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadEnv } from './config';
import { createMcpServer } from './server';

const env = loadEnv();
const log = createLogger({ name: 'mcp', level: env.LOG_LEVEL, destination: process.stderr });
const db = connect(env.DATABASE_URL);
const caller = env.ATTENDRA_API_KEY ? await authenticateApiKey(db, env.ATTENDRA_API_KEY) : null;
if (!caller) {
  log.error('ATTENDRA_API_KEY is missing, revoked or expired: make one in Settings > API keys');
  process.exit(2);
}
const server = createMcpServer(caller, { db, cipher: createPhiCipher(env.ATTENDRA_DATA_KEY), log });
await server.connect(new StdioServerTransport());
log.info({ clinic_id: caller.clinicId, key_id: caller.keyId, scopes: caller.scopes }, 'mcp server on stdio');
