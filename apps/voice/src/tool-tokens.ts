// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The tools API's own credential for one call (API-7): minted when a tools-path call is accepted, good for that call
 * only (its clinic and call id) while it is live (TOOL_TOKEN_MAX_MS at most), and checked on every request to the HTTP surface
 * (`POST /tools/v1/:tool`). An engine that runs outside our process (Vapi's tool server, later) carries it as its
 * bearer. Signed with HMAC-SHA256 under a key this service already holds; it carries ids only, never a caller's detail.
 */
export interface ToolToken { callId: string; clinicId: string; expiresAt: number }

/** The longest a token is good for; the HTTP surface also refuses it once its call has ended. */
export const TOOL_TOKEN_MAX_MS = 2 * 3_600_000;

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');
const sign = (key: string, body: string) => createHmac('sha256', key).update(`attendra.tools.v1.${body}`).digest('base64url');

export function mintToolToken(key: string, t: ToolToken): string {
  const body = b64(JSON.stringify({ c: t.callId, k: t.clinicId, e: t.expiresAt }));
  return `${body}.${sign(key, body)}`;
}

/** The token's call, when it is genuine and not expired; null otherwise. */
export function readToolToken(key: string, token: string | undefined, now = Date.now()): ToolToken | null {
  if (!token) return null;
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra !== undefined) return null;
  const want = Buffer.from(sign(key, body));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { c?: unknown; k?: unknown; e?: unknown };
    if (typeof p.c !== 'string' || typeof p.k !== 'string' || typeof p.e !== 'number' || p.e < now) return null;
    return { callId: p.c, clinicId: p.k, expiresAt: p.e };
  } catch {
    return null;
  }
}
