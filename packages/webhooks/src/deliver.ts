// SPDX-License-Identifier: AGPL-3.0-only
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { webhookHeaders } from './sign';
import { type GuardOptions, type Resolver, resolveEndpoint } from './ssrf';

export interface DeliveryResult {
  ok: boolean;
  status: number | null;
  ms: number;
  /** A code, never a response body: https_only, private_address, timeout, http_500. */
  error: string | null;
}

/**
 * One POST of one event to one endpoint. The address is checked after DNS and the
 * connection is made to that exact address (with the name kept for TLS and the Host
 * header). Redirects are not followed, the body is not read beyond a few kilobytes,
 * and the whole delivery, DNS included, has one deadline (10 seconds by default): a
 * receiver that trickles its answer a byte at a time is cut off like a silent one.
 * Any 2xx is a delivery.
 */
export async function deliver(
  target: { url: string; secrets: string[] },
  message: { id: string; body: string; timestamp?: number },
  opts: GuardOptions & { resolve?: Resolver; timeoutMs?: number } = {},
): Promise<DeliveryResult> {
  const started = Date.now();
  const deadline = started + (opts.timeoutMs ?? 10_000);
  const done = (r: Omit<DeliveryResult, 'ms'>): DeliveryResult => ({ ...r, ms: Date.now() - started });
  const checked = await Promise.race([
    resolveEndpoint(target.url, opts),
    new Promise<null>((r) => { setTimeout(() => r(null), deadline - Date.now()).unref?.(); }),
  ]);
  if (!checked) return done({ ok: false, status: null, error: 'timeout' });
  if (!checked.ok) return done({ ok: false, status: null, error: checked.problem });
  const timestamp = message.timestamp ?? Math.floor(Date.now() / 1000);
  const headers = {
    'content-type': 'application/json', 'user-agent': 'Attendra-Webhooks/1',
    ...webhookHeaders(target.secrets, message.id, timestamp, message.body),
  };
  const r = await postPinned(checked.url, checked.address, checked.family, headers, message.body, Math.max(1, deadline - Date.now()));
  return done(r);
}

/**
 * The POST itself, to `address` whatever the URL's name resolves to now: the name is
 * kept only for TLS and the Host header. `timeoutMs` is a total deadline, from the
 * connection to the last byte of the answer, enforced with an AbortController and
 * req.destroy(). Exported for the tests that prove both.
 */
export function postPinned(url: URL, address: string, family: 4 | 6, headers: Record<string, string>, body: string, timeoutMs: number): Promise<Omit<DeliveryResult, 'ms'>> {
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((outer) => {
    const abort = new AbortController();
    let settled = false;
    const resolve = (r: Omit<DeliveryResult, 'ms'>) => { if (!settled) { settled = true; clearTimeout(timer); outer(r); } };
    const timer = setTimeout(() => {
      resolve({ ok: false, status: null, error: 'timeout' });
      abort.abort();
      req.destroy(new Error('timeout'));
    }, timeoutMs);
    const req = send(url, {
      signal: abort.signal,
      method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) },
      lookup: (_host, options, cb) => {
        if ((options as { all?: boolean }).all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address, family }]);
        else cb(null, address, family);
      },
      timeout: timeoutMs,
    }, (res) => {
      abort.signal.addEventListener('abort', () => res.destroy(), { once: true });
      let read = 0;
      res.on('data', (chunk: Buffer) => { read += chunk.length; if (read > 4096) res.destroy(); });
      res.on('close', () => {
        const status = res.statusCode ?? null;
        const ok = !!status && status >= 200 && status < 300;
        resolve({ ok, status, error: ok ? null : `http_${status}` });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ ok: false, status: null, error: err.message === 'timeout' ? 'timeout' : 'connection_failed' }));
    req.end(body);
  });
}
