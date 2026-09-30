// SPDX-License-Identifier: AGPL-3.0-only
import { authenticateApiKey } from '@attendra/db';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMcpServer, type McpDeps } from './server';

const MAX_BODY = 1024 * 1024;

/**
 * A minute's allowance: requests per key, and requests without a working key per
 * address (someone guessing keys). Failures are counted by address, and a working key
 * by its id, so clients behind one proxy do not share an allowance, and an address
 * held back for failures still serves a working key.
 */
export interface McpRateLimit { failuresPerAddress: number; perKey: number }
const DEFAULT_LIMIT: McpRateLimit = { failuresPerAddress: 30, perKey: 120 };

/** A sliding one-minute window per name. In memory: one MCP server process, as deployed. */
function windowCounter(limit: number) {
  const hits = new Map<string, number[]>();
  const recent = (name: string, now: number) => (hits.get(name) ?? []).filter((t) => t > now - 60_000);
  return {
    full: (name: string, now = Date.now()) => recent(name, now).length >= limit,
    add: (name: string, now = Date.now()) => {
      hits.set(name, [...recent(name, now), now]);
      if (hits.size > 10_000) for (const [k, v] of hits) if (!v.some((t) => t > now - 60_000)) hits.delete(k);
    },
  };
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { size += c.length; if (size > MAX_BODY) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined); } catch { reject(new Error('invalid_json')); } });
    req.on('error', reject);
  });
}

const deny = (res: ServerResponse, status: number, message: string) => {
  res.writeHead(status, { 'content-type': 'application/json', ...(status === 401 ? { 'www-authenticate': 'Bearer realm="attendra"' } : {}), ...(status === 429 ? { 'retry-after': '60' } : {}) });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }));
};

/**
 * MCP over Streamable HTTP, stateless: every request carries its API key as a bearer
 * token and gets a server of its own for that key, so nothing about one caller
 * outlives its request. Only POST /mcp is served.
 */
export function mcpHttpHandler(d: McpDeps & { rateLimit?: McpRateLimit; addressOf?: (req: IncomingMessage) => string }) {
  const limit = d.rateLimit ?? DEFAULT_LIMIT;
  const failures = windowCounter(limit.failuresPerAddress);
  const byKey = windowCounter(limit.perKey);
  const addressOf = d.addressOf ?? ((req: IncomingMessage) => req.socket.remoteAddress ?? 'unknown');
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/mcp') return deny(res, 404, 'not found');
    if (req.method !== 'POST') return deny(res, 405, 'this server is stateless: POST only');
    const address = addressOf(req);
    // the key first: one client guessing behind a shared proxy must not lock out the working keys there
    const auth = req.headers.authorization ?? '';
    const caller = auth.startsWith('Bearer ') ? await authenticateApiKey(d.db, auth.slice(7).trim(), (d.now ?? (() => new Date()))()) : null;
    if (!caller) {
      if (failures.full(address)) return deny(res, 429, 'too many requests without a working key: wait a minute');
      failures.add(address);
      return deny(res, 401, 'a valid, unexpired Attendra API key is required as a bearer token');
    }
    if (byKey.full(caller.keyId)) return deny(res, 429, 'too many requests for this key: wait a minute');
    byKey.add(caller.keyId);
    let body: unknown;
    try { body = await readBody(req); } catch (err) { return deny(res, (err as Error).message === 'too_large' ? 413 : 400, (err as Error).message); }
    const server = createMcpServer(caller, d);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}
