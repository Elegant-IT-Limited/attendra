import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config';
import { clientAddress, isCloudflare } from '../src/http/client-address';
import { CLOUDFLARE_IPV4, CLOUDFLARE_IPV6 } from '../src/http/cloudflare-ips';
import { startApi } from './helpers';

// documentation addresses (RFC 5737, RFC 3849) for clients; 104.16.0.10 and 2606:4700::6810 are Cloudflare's
const CF_EDGE = '104.16.0.10';
const CF_EDGE_V6 = '2606:4700::6810';
const CLIENT_A = '198.51.100.7';
const CLIENT_B = '203.0.113.9';
const DIRECT = '192.0.2.44';
const DASHBOARD = '172.18.0.5';

describe('the client address behind Cloudflare', () => {
  it("knows Cloudflare's addresses, both families, and nothing else", () => {
    expect(CLOUDFLARE_IPV4.length).toBeGreaterThan(10);
    expect(CLOUDFLARE_IPV6.length).toBeGreaterThan(5);
    expect(isCloudflare(CF_EDGE)).toBe(true);
    expect(isCloudflare(`::ffff:${CF_EDGE}`)).toBe(true);
    expect(isCloudflare(CF_EDGE_V6)).toBe(true);
    expect(isCloudflare(DIRECT)).toBe(false);
    expect(isCloudflare('2001:db8::1')).toBe(false);
    expect(isCloudflare('not an address')).toBe(false);
  });

  it('takes CF-Connecting-IP only from a Cloudflare hop, only when turned on, and only when it is an address', () => {
    const via = (ip: string, header?: string) => ({ ip, headers: header === undefined ? {} : { 'cf-connecting-ip': header } });
    expect(clientAddress(via(CF_EDGE, CLIENT_A), true)).toBe(CLIENT_A);
    expect(clientAddress(via(CF_EDGE_V6, '2001:db8::7'), true)).toBe('2001:db8::7');
    // a spoofed header from a hop that is not Cloudflare's is ignored
    expect(clientAddress(via(DIRECT, CLIENT_A), true)).toBe(DIRECT);
    // off (the default): the header means nothing, whoever sends it
    expect(clientAddress(via(CF_EDGE, CLIENT_A), false)).toBe(CF_EDGE);
    // from Cloudflare, but no usable header: the hop itself
    expect(clientAddress(via(CF_EDGE), true)).toBe(CF_EDGE);
    expect(clientAddress(via(CF_EDGE, 'evil, 198.51.100.7'), true)).toBe(CF_EDGE);
  });

  it('is off unless asked for, and needs TRUST_PROXY', () => {
    const base = { DATABASE_URL: 'postgres://a:b@localhost:5432/c', ATTENDRA_DATA_KEY: 'x'.repeat(44), BETTER_AUTH_SECRET: 'y'.repeat(40) };
    expect(loadEnv(base).TRUST_CLOUDFLARE).toBe(false);
    expect(loadEnv({ ...base, TRUST_PROXY: 'true', TRUST_CLOUDFLARE: 'true' })).toMatchObject({ TRUST_PROXY: 1, TRUST_CLOUDFLARE: true });
    expect(() => loadEnv({ ...base, TRUST_CLOUDFLARE: 'true' })).toThrow('TRUST_CLOUDFLARE needs TRUST_PROXY');
  });
});

describe("the API's per-address limit behind Cloudflare", () => {
  // a small budget, so the test reaches it quickly
  const MAX = 6;
  let api: Awaited<ReturnType<typeof startApi>>;
  beforeAll(async () => { api = await startApi({ demoMode: true, rateLimit: MAX, trustProxy: 1, trustCloudflare: true }); });
  afterAll(() => api.close());

  /** Requests through the dashboard's proxy until the first 429; how many went through. */
  async function budget(edge: string, cfConnectingIp: string) {
    for (let i = 0; i < MAX * 2; i++) {
      const res = await api.request('GET', '/api/v1/health', { remoteAddress: DASHBOARD, headers: { 'x-forwarded-for': edge, 'cf-connecting-ip': cfConnectingIp } });
      if (res.statusCode === 429) return i;
    }
    return Infinity;
  }

  it("counts each client Cloudflare names on its own, and ignores the name from a hop that is not Cloudflare's", async () => {
    expect(await budget(CF_EDGE, CLIENT_A)).toBe(MAX);
    // the same Cloudflare edge, another client: a budget of its own
    expect(await budget(CF_EDGE, CLIENT_B)).toBe(MAX);
    // straight to the server, a new made-up name on every try: still one address, one budget
    expect(await budget(DIRECT, '198.51.100.100')).toBe(MAX);
    expect(await budget(DIRECT, '198.51.100.101')).toBe(0);
  });
});
