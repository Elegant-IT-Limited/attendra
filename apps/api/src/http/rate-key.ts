// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * What the API's per-minute limit counts by: the signed-in session when the request has
 * one, the address otherwise. A clinic's whole team often shares one office connection,
 * and keyed by address they shared one budget: a few open tabs turned everyone away.
 *
 * Only a session cookie this server signed counts as one. Better Auth signs the token
 * with HMAC-SHA256 (`token.signature`, URL-encoded), so a made-up cookie cannot buy a
 * fresh budget: it falls back to the address. The check is the signature alone, with no
 * database read, and the token is kept only as a hash.
 */
export function rateLimitKey(auth: { cookieName: string; secret: string }) {
  return (req: { ip: string; headers: { cookie?: string } }): string => {
    const token = signedToken(req.headers.cookie, auth.cookieName, auth.secret);
    return token ? `session:${createHash('sha256').update(token).digest('base64url').slice(0, 32)}` : `ip:${req.ip}`;
  };
}

/** The session token in a signed session cookie, or null when there is none or its signature is wrong. */
export function signedToken(header: string | undefined, name: string, secret: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    let value: string;
    try { value = decodeURIComponent(part.slice(eq + 1).trim()); } catch { return null; }
    const dot = value.lastIndexOf('.');
    if (dot < 1) return null;
    const token = value.slice(0, dot);
    const given = Buffer.from(value.slice(dot + 1), 'base64');
    const expected = createHmac('sha256', secret).update(token).digest();
    return given.length === expected.length && timingSafeEqual(given, expected) ? token : null;
  }
  return null;
}
