import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkUrlShape, deliver, eventId, isPublicAddress, newSecret, payloadOf, postPinned, resolveEndpoint, signature, verify, webhookHeaders } from '../src';

describe('Standard Webhooks signatures', () => {
  it('matches the specification\'s own example', () => {
    // from standardwebhooks.com: the reference secret, message id, timestamp and body
    expect(signature('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', 'msg_p5jXN8AQM9LWM0D4loKWxJek', 1614265330, '{"test": 2432232314}'))
      .toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
  });

  it('verifies a delivery, and refuses a changed body, a wrong secret or an old timestamp', () => {
    const secret = newSecret();
    const now = 1_790_000_000_000;
    const headers = webhookHeaders([secret], 'msg_1', now / 1000, '{"a":1}');
    expect(verify(secret, headers, '{"a":1}', now)).toBe(true);
    expect(verify(secret, headers, '{"a":2}', now)).toBe(false);
    expect(verify(newSecret(), headers, '{"a":1}', now)).toBe(false);
    expect(verify(secret, headers, '{"a":1}', now + 301_000)).toBe(false);
  });

  it('signs with both secrets while one is being rotated, so either verifies', () => {
    const [old, fresh] = [newSecret(), newSecret()];
    const headers = webhookHeaders([fresh, old], 'msg_2', 1_790_000_000, 'x');
    expect(headers['webhook-signature']!.split(' ')).toHaveLength(2);
    expect(verify(old, headers, 'x', 1_790_000_000_000)).toBe(true);
    expect(verify(fresh, headers, 'x', 1_790_000_000_000)).toBe(true);
  });

  it('gives the same event the same id, and a payload with no room for anything else', () => {
    expect(eventId('appointment.booked', 'appt_1')).toBe(eventId('appointment.booked', 'appt_1'));
    expect(eventId('appointment.booked', 'appt_1')).not.toBe(eventId('appointment.cancelled', 'appt_1'));
    expect(JSON.parse(payloadOf({ id: 'evt_1', clinicId: 'c', type: 'request.done', occurredAt: '2026-09-30T10:00:00.000Z', data: { requestId: 'r' } })))
      .toEqual({ type: 'request.done', timestamp: '2026-09-30T10:00:00.000Z', data: { clinicId: 'c', requestId: 'r' } });
  });

  it('leaves the patient id out when the endpoint asks, as endpoints do by default', () => {
    const booked = { id: 'evt_2', clinicId: 'c', type: 'appointment.booked' as const, occurredAt: '2026-09-30T10:00:00.000Z', data: { appointmentId: 'a', patientId: 'p', startsAt: '2026-10-06T15:00:00.000Z' } };
    expect(JSON.parse(payloadOf(booked, { omitPatientIds: true })).data).toEqual({ clinicId: 'c', appointmentId: 'a', startsAt: '2026-10-06T15:00:00.000Z' });
    expect(JSON.parse(payloadOf(booked)).data.patientId).toBe('p');
  });
});

describe('the SSRF guard', () => {
  it('allows only public https URLs', () => {
    expect(checkUrlShape('https://hooks.example.com/attendra').ok).toBe(true);
    for (const [url, problem] of [
      ['http://hooks.example.com/x', 'https_only'], ['ftp://example.com', 'https_only'], ['not a url', 'invalid_url'],
      ['https://user:pass@example.com', 'credentials_in_url'], ['https://localhost/x', 'private_address'], ['https://app.localhost', 'private_address'],
      ['https://127.0.0.1/x', 'private_address'], ['https://10.1.2.3', 'private_address'], ['https://192.168.1.10', 'private_address'], ['https://172.20.0.5', 'private_address'],
      ['https://169.254.169.254/latest/meta-data', 'private_address'], ['https://metadata.google.internal', 'private_address'], ['https://[::1]/x', 'private_address'],
      ['https://[fd00::1]', 'private_address'], ['https://[fe80::1]', 'private_address'], ['https://100.64.0.1', 'private_address'], ['https://0.0.0.0', 'private_address'],
      ['https://[::ffff:127.0.0.1]', 'private_address'], ['https://[::ffff:a9fe:a9fe]', 'private_address'], ['https://printer.local', 'private_address'],
    ] as const) {
      expect(checkUrlShape(url), url).toEqual({ ok: false, problem });
    }
  });

  it('knows public addresses from private ones, including IPv4 hidden in IPv6', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
    expect(isPublicAddress('::ffff:8.8.8.8')).toBe(true);
    expect(isPublicAddress('::ffff:10.0.0.1')).toBe(false);
    expect(isPublicAddress('64:ff9b::a9fe:a9fe')).toBe(false);
    expect(isPublicAddress('not-an-ip')).toBe(false);
    expect(isPublicAddress('0:0:0:0:0:ffff:7f00:1')).toBe(false); // 127.0.0.1, written out in full
    expect(isPublicAddress('::1')).toBe(false);
  });

  it('refuses a public name that resolves to a private address, even once among public ones', async () => {
    const to = (...addresses: string[]) => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    expect(await resolveEndpoint('https://hooks.example.com', { resolve: to('93.184.216.34') })).toMatchObject({ ok: true, address: '93.184.216.34', family: 4 });
    expect(await resolveEndpoint('https://rebind.example.com', { resolve: to('169.254.169.254') })).toEqual({ ok: false, problem: 'private_address' });
    expect(await resolveEndpoint('https://mixed.example.com', { resolve: to('93.184.216.34', '10.0.0.7') })).toEqual({ ok: false, problem: 'private_address' });
    expect(await resolveEndpoint('https://gone.example.com', { resolve: async () => { throw new Error('ENOTFOUND'); } })).toEqual({ ok: false, problem: 'unresolvable' });
  });

  it('allows plain HTTP to this machine only when told to, for local development', () => {
    expect(checkUrlShape('http://127.0.0.1:4000/hook')).toEqual({ ok: false, problem: 'https_only' });
    expect(checkUrlShape('http://127.0.0.1:4000/hook', { allowLoopback: true }).ok).toBe(true);
    expect(checkUrlShape('http://10.0.0.1/hook', { allowLoopback: true })).toEqual({ ok: false, problem: 'https_only' });
  });
});

describe('delivering', () => {
  let server: Server;
  let port: number;
  const got: { url: string; headers: IncomingMessage['headers']; body: string }[] = [];
  let respond = 200;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        got.push({ url: req.url ?? '', headers: req.headers, body });
        if (req.url === '/slow') return void setTimeout(() => res.end(), 2000);
        // headers at once, then a byte every 100 ms, never ending: the socket is never idle
        if (req.url === '/trickle') {
          res.writeHead(200);
          const t = setInterval(() => res.write('.'), 100);
          res.on('close', () => clearInterval(t));
          return;
        }
        if (req.url === '/moved') { res.writeHead(302, { location: 'http://169.254.169.254/' }); return void res.end(); }
        res.statusCode = respond;
        res.end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => server.close());

  it('posts the body with headers a receiver can verify', async () => {
    const secret = newSecret();
    const r = await deliver({ url: `http://127.0.0.1:${port}/hook`, secrets: [secret] }, { id: 'evt_a', body: '{"type":"request.done"}' }, { allowLoopback: true });
    expect(r).toMatchObject({ ok: true, status: 200, error: null });
    const last = got.at(-1)!;
    expect(last.body).toBe('{"type":"request.done"}');
    expect(verify(secret, last.headers as Record<string, string>, last.body)).toBe(true);
    expect(last.headers['user-agent']).toBe('Attendra-Webhooks/1');
  });

  it('reports a failure by its status code, follows no redirect, and gives up on a slow receiver', async () => {
    respond = 500;
    expect(await deliver({ url: `http://127.0.0.1:${port}/hook`, secrets: [newSecret()] }, { id: 'evt_b', body: '{}' }, { allowLoopback: true })).toMatchObject({ ok: false, status: 500, error: 'http_500' });
    respond = 200;
    const before = got.length;
    expect(await deliver({ url: `http://127.0.0.1:${port}/moved`, secrets: [newSecret()] }, { id: 'evt_c', body: '{}' }, { allowLoopback: true })).toMatchObject({ ok: false, status: 302 });
    expect(got.length).toBe(before + 1); // the redirect was not followed
    expect(await deliver({ url: `http://127.0.0.1:${port}/slow`, secrets: [newSecret()] }, { id: 'evt_d', body: '{}' }, { allowLoopback: true, timeoutMs: 300 })).toMatchObject({ ok: false, error: 'timeout' });
  });

  it('cuts off a receiver that trickles its answer, at the total deadline, however busy the socket is', async () => {
    const started = Date.now();
    const r = await deliver({ url: `http://127.0.0.1:${port}/trickle`, secrets: [newSecret()] }, { id: 'evt_t', body: '{}' }, { allowLoopback: true, timeoutMs: 800 });
    expect(r).toMatchObject({ ok: false, status: null, error: 'timeout' });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(r.ms).toBeGreaterThanOrEqual(750);
  });

  it('counts DNS against the same deadline', async () => {
    const hang = () => new Promise<never>(() => {});
    const r = await deliver({ url: 'https://hooks.example.com/x', secrets: [newSecret()] }, { id: 'evt_u', body: '{}' }, { resolve: hang, timeoutMs: 300 });
    expect(r).toMatchObject({ ok: false, error: 'timeout' });
    expect(r.ms).toBeLessThan(1000);
  });

  it('never connects to a private address, and connects to the address it checked, not a second DNS answer', async () => {
    const before = got.length;
    expect(await deliver({ url: `http://127.0.0.1:${port}/hook`, secrets: [newSecret()] }, { id: 'evt_e', body: '{}' })).toMatchObject({ ok: false, error: 'https_only', status: null });
    expect(await deliver({ url: 'https://internal.example.com/hook', secrets: [newSecret()] }, { id: 'evt_f', body: '{}' }, { resolve: async () => [{ address: '10.0.0.5', family: 4 }] }))
      .toMatchObject({ ok: false, error: 'private_address' });
    expect(got.length).toBe(before);
    // the connection goes to the checked address: a name that cannot resolve at all still arrives
    const r = await postPinned(new URL(`http://pinned.invalid:${port}/hook`), '127.0.0.1', 4, { 'content-type': 'application/json' }, '{}', 2000);
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(got.at(-1)!.headers.host).toBe(`pinned.invalid:${port}`);
  });
});
