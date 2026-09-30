// SPDX-License-Identifier: AGPL-3.0-only
// MCP over Streamable HTTP at POST /mcp. Put it behind HTTPS; each request carries an
// Attendra API key as a bearer token.
import { connect, createPhiCipher } from '@attendra/db';
import { createLogger } from '@attendra/observability';
import { bossQueue, createBoss, eventSink } from '@attendra/worker/queue';
import { createServer } from 'node:http';
import { loadEnv } from './config';
import { mcpHttpHandler } from './http-handler';

const env = loadEnv();
const log = createLogger({ name: 'mcp', level: env.LOG_LEVEL });
const db = connect(env.DATABASE_URL, { onError: (code) => log.error({ code }, 'database connection error') });
// sends events only (a request closed here reaches the clinic's webhooks); the worker delivers them
const boss = createBoss({ connectionString: env.DATABASE_URL }, { producer: true });
boss.on('error', (err: Error & { code?: string }) => log.error({ code: err.code ?? 'unknown' }, 'job queue error'));
await boss.start();
const events = eventSink(bossQueue(boss));
const handle = mcpHttpHandler({
  db, cipher: createPhiCipher(env.ATTENDRA_DATA_KEY), log,
  onRequestDone: (clinicId, facts) => events.emit(clinicId, { type: 'request.done', key: String(facts.requestId), data: facts }),
});
const server = createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    log.error({ err: { name: (err as Error).name } }, 'mcp request failed');
    if (!res.headersSent) { res.writeHead(500); res.end(); }
  });
});
server.listen(env.MCP_PORT, '0.0.0.0', () => log.info({ port: env.MCP_PORT }, 'mcp server on http'));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { server.close(); void boss.stop({ graceful: true }).then(() => process.exit(0)); });
