// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyReply, FastifyRequest } from 'fastify';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';

const brotli = promisify(brotliCompress);
const gzipped = promisify(gzip);

/** Below this a compressed answer saves less than the time it takes; most small JSON answers stay as they are. */
export const COMPRESS_MIN_BYTES = 1024;

/** The encoding a request accepts, best first: brotli, then gzip, else none. A q=0 refuses one. */
export function acceptedEncoding(header: string | string[] | undefined): 'br' | 'gzip' | null {
  const offered = new Map(String(header ?? '').split(',').map((part) => {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const q = params.map((p) => /^\s*q=([\d.]+)/.exec(p)?.[1]).find(Boolean);
    return [name!, q === undefined ? 1 : Number(q)] as const;
  }));
  const ok = (name: string) => (offered.get(name) ?? offered.get('*') ?? 0) > 0;
  return ok('br') ? 'br' : ok('gzip') ? 'gzip' : null;
}

/**
 * An onSend hook: JSON and text answers of 1 KB or more go out compressed when the browser accepts it (brotli at a
 * fast level, else gzip), with Vary: Accept-Encoding. Streams (the change stream, recordings), answers already
 * encoded and anything binary go as they are. No dependency: node's own zlib, off the event loop.
 */
export async function compressReply(req: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> {
  if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) return payload;
  if (reply.getHeader('content-encoding') || req.method === 'HEAD') return payload;
  const type = String(reply.getHeader('content-type') ?? '');
  if (!/^(application\/(json|problem\+json)|text\/(plain|html|markdown|csv))/.test(type)) return payload;
  const body = typeof payload === 'string' ? Buffer.from(payload) : payload;
  reply.header('vary', appendVary(reply.getHeader('vary')));
  if (body.length < COMPRESS_MIN_BYTES) return payload;
  const encoding = acceptedEncoding(req.headers['accept-encoding']);
  if (!encoding) return payload;
  const out = encoding === 'br'
    ? await brotli(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 4, [constants.BROTLI_PARAM_SIZE_HINT]: body.length } })
    : await gzipped(body, { level: 6 });
  reply.header('content-encoding', encoding);
  reply.removeHeader('content-length');
  return out;
}

function appendVary(current: unknown): string {
  const list = String(current ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  return list.some((v) => v.toLowerCase() === 'accept-encoding' || v === '*') ? list.join(', ') : [...list, 'Accept-Encoding'].join(', ');
}
