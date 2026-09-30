// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Standard Webhooks (standardwebhooks.com): each delivery carries webhook-id,
 * webhook-timestamp and webhook-signature, the signature being
 * "v1," + base64(HMAC-SHA256(secret, id + "." + timestamp + "." + body)). The secret
 * is "whsec_" and 24 random bytes in base64; the HMAC key is the decoded bytes.
 */
export const newSecret = () => `whsec_${randomBytes(24).toString('base64')}`;

const keyOf = (secret: string) => {
  if (!secret.startsWith('whsec_')) throw new Error('a webhook secret starts with whsec_');
  return Buffer.from(secret.slice(6), 'base64');
};

export function signature(secret: string, id: string, timestamp: number, body: string): string {
  return `v1,${createHmac('sha256', keyOf(secret)).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

/** The three headers. While a secret is being rotated, both are used, space separated, as the spec allows. */
export function webhookHeaders(secrets: string[], id: string, timestamp: number, body: string): Record<string, string> {
  return {
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': secrets.map((s) => signature(s, id, timestamp, body)).join(' '),
  };
}

/**
 * Checks a delivery the way a receiver should: the signature, in constant time, and a
 * timestamp within five minutes, so an old delivery cannot be replayed. Here for tests
 * and as the reference the docs' examples follow.
 */
export function verify(secret: string, headers: Record<string, string | undefined>, body: string, now = Date.now(), toleranceSeconds = 300): boolean {
  const id = headers['webhook-id'];
  const ts = Number(headers['webhook-timestamp']);
  const sent = headers['webhook-signature'];
  if (!id || !Number.isFinite(ts) || !sent) return false;
  if (Math.abs(now / 1000 - ts) > toleranceSeconds) return false;
  const expected = Buffer.from(signature(secret, id, ts, body));
  return sent.split(' ').some((s) => { const b = Buffer.from(s); return b.length === expected.length && timingSafeEqual(b, expected); });
}
