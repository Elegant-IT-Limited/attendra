// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed requests between the engine and its hosting layer (provisioning one way, the mail
 * hook the other). The shared provisioning token is the HMAC key and never travels: a
 * request carries the time it was made and an HMAC-SHA256 of that time, the method, the
 * path with its query, and a hash of the body. A captured request is useless after
 * SIGNATURE_WINDOW_S, and cannot be turned into another (other path, other body).
 *
 *   attendra-timestamp: 1794033400
 *   attendra-signature: v1=<64 hex characters>
 *   signed text: `${timestamp}\n${METHOD}\n${path?query}\n${sha256 hex of the raw body, or of "" when none}`
 *
 * The hosting layer's copy (attendra-cloud, src/lib/signature.ts) follows this file and
 * checks the same fixed example in its tests (SIGNATURE_EXAMPLE below).
 */
export const TIMESTAMP_HEADER = 'attendra-timestamp';
export const SIGNATURE_HEADER = 'attendra-signature';
/** How far a request's time may be from ours, either way, in seconds. */
export const SIGNATURE_WINDOW_S = 300;

const sha256 = (body: string | Uint8Array) => createHash('sha256').update(body).digest('hex');

function signedText(timestamp: string, method: string, path: string, body: string | Uint8Array | undefined) {
  return `${timestamp}\n${method.toUpperCase()}\n${path}\n${sha256(body ?? '')}`;
}

/** The two headers for a request: its time, and the signature over it. */
export function signRequest(key: string, req: { method: string; path: string; body?: string | Uint8Array }, now = new Date()): Record<string, string> {
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const mac = createHmac('sha256', key).update(signedText(timestamp, req.method, req.path, req.body)).digest('hex');
  return { [TIMESTAMP_HEADER]: timestamp, [SIGNATURE_HEADER]: `v1=${mac}` };
}

export type SignatureCheck = 'valid' | 'missing' | 'stale' | 'invalid';

/** Whether a request carries a valid signature made with `key` within the window. */
export function checkSignature(
  key: string,
  req: { method: string; path: string; body?: string | Uint8Array; headers: Record<string, string | string[] | undefined> },
  now = new Date(),
): SignatureCheck {
  const timestamp = req.headers[TIMESTAMP_HEADER];
  const signature = req.headers[SIGNATURE_HEADER];
  if (timestamp === undefined && signature === undefined) return 'missing';
  if (typeof timestamp !== 'string' || typeof signature !== 'string' || !/^\d{1,12}$/.test(timestamp)) return 'invalid';
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > SIGNATURE_WINDOW_S) return 'stale';
  const match = /^v1=([0-9a-f]{64})$/.exec(signature);
  if (!match) return 'invalid';
  const expected = createHmac('sha256', key).update(signedText(timestamp, req.method, req.path, req.body)).digest();
  return timingSafeEqual(expected, Buffer.from(match[1]!, 'hex')) ? 'valid' : 'invalid';
}

/**
 * A fixed example both sides check in their tests, so the two copies of this format can
 * never drift apart unnoticed. Made-up key; never a real one.
 */
export const SIGNATURE_EXAMPLE = {
  key: 'an-example-provisioning-token-0123456789',
  method: 'POST',
  path: '/api/v1/provisioning/accounts?replace=1',
  body: '{"clinic":{"name":"Maple Street Vets"}}',
  at: new Date('2026-11-07T12:00:00.000Z'),
  headers: {
    [TIMESTAMP_HEADER]: '1794052800',
    [SIGNATURE_HEADER]: 'v1=30c507e679bcbb5b308289e5c979e4b485a880d675e819fff21436f3ce1961d2',
  },
};
