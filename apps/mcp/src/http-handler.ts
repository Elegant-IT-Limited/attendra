// SPDX-License-Identifier: AGPL-3.0-only
import { authenticateApiKey } from '@attendra/db';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMcpServer, type McpDeps } from './server';

const MAX_BODY = 1024 * 1024;

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
  res.writeHead(status, { 'content-type': 'application/json', ...(status === 401 ? { 'www-authenticate': 'Bearer realm="attendra"' } : {}) });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }));
};

/**
 * MCP over Streamable HTTP, stateless: every request carries its API key as a bearer
 * token and gets a server of its own for that key, so nothing about one caller
 * outlives its request. Only POST /mcp is served.
 */
export function mcpHttpHandler(d: McpDeps) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/mcp') return deny(res, 404, 'not found');
    if (req.method !== 'POST') return deny(res, 405, 'this server is stateless: POST only');
    const auth = req.headers.authorization ?? '';
    const caller = auth.startsWith('Bearer ') ? await authenticateApiKey(d.db, auth.slice(7).trim(), (d.now ?? (() => new Date()))()) : null;
    if (!caller) return deny(res, 401, 'a valid, unexpired Attendra API key is required as a bearer token');
    let body: unknown;
    try { body = await readBody(req); } catch (err) { return deny(res, (err as Error).message === 'too_large' ? 413 : 400, (err as Error).message); }
    const server = createMcpServer(caller, d);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}
