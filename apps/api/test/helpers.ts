import { DEMO_CLINIC } from '@attendra/core';
import { CallRepository, createPhiCipher, pgliteChangeFeed, PostgresTaskQueue, saveClinic, seedDemo } from '@attendra/db';
import { openTestDatabase, TEST_DATA_KEY } from '@attendra/db/testing';
import { createLogger } from '@attendra/observability';
import { createHmac } from 'node:crypto';
import { Writable } from 'node:stream';
import { type ApiDeps, createApi } from '../src/app';
import { createAuth } from '../src/auth';
import type { ApiOptions, VoiceClient } from '../src/http/tokens';
import { addMember } from '../src/members';

export const ORIGIN = 'http://localhost:3000';
export const PASSWORD = 'correct horse battery staple';
export const OTHER = { ...DEMO_CLINIC, id: 'clinic_other', name: 'Other Clinic', phoneNumbers: ['+13035550200'] };

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) from an otpauth:// URI, as an authenticator app computes it. */
export function totp(uri: string, at = Date.now()) {
  const secret = new URL(uri).searchParams.get('secret')!;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** `logs` collects every line the API and Better Auth log, for tests that prove something never reaches them. */
export async function startApi(opts: { demoMode: boolean; voice?: VoiceClient | null; now?: () => Date; logs?: string[]; liveStream?: ApiOptions['liveStream']; changes?: boolean } & Pick<ApiDeps, 'jobs' | 'knowledge' | 'webhooks'>) {
  const t = await openTestDatabase();
  const cipher = createPhiCipher(TEST_DATA_KEY);
  const { patientIds } = await seedDemo(t.db, cipher);
  await saveClinic(t.db, 'org_other', OTHER);
  const log = createLogger({ name: 'test', level: opts.logs ? 'debug' : 'info', destination: new Writable({ write: (c, _e, done) => { opts.logs?.push(String(c)); done(); } }) });
  const auth = createAuth(t.db, { publicUrl: ORIGIN, secret: 'test-secret-that-is-at-least-32-characters', rateLimit: false, log });
  const users = {
    owner: await addMember(auth, t.db, { email: 'omar@maple.example', name: 'Omar Owner', password: PASSWORD, orgId: 'org_demo', role: 'owner' }),
    admin: await addMember(auth, t.db, { email: 'olga@maple.example', name: 'Olga Admin', password: PASSWORD, orgId: 'org_demo', role: 'admin' }),
    staff: await addMember(auth, t.db, { email: 'ana@maple.example', name: 'Ana Front', password: PASSWORD, orgId: 'org_demo', role: 'staff' }),
    viewer: await addMember(auth, t.db, { email: 'vic@maple.example', name: 'Vic Viewer', password: PASSWORD, orgId: 'org_demo', role: 'viewer' }),
    outsider: await addMember(auth, t.db, { email: 'otto@other.example', name: 'Otto Other', password: PASSWORD, orgId: 'org_other', role: 'owner' }),
  };

  const calls = new CallRepository(t.db, cipher);
  const callId = await calls.open(DEMO_CLINIC.id, 'live_api_1', '+13035550147');
  await calls.appendSegment(DEMO_CLINIC.id, callId, { speaker: 'caller', text: 'Hi, this is Maria Delgado. Can I get my lisinopril refilled?', startMs: 0, endMs: 1200 });
  await calls.close(DEMO_CLINIC.id, callId, { reason: 'caller_hangup', voiceSeconds: 48, outcome: 'task_created', emergency: false });
  const { id: taskId } = await new PostgresTaskQueue(t.db, cipher).create(DEMO_CLINIC.id, {
    type: 'refill', callId, patientId: patientIds.maria!, idempotencyKey: 'api-refill', details: { medication: 'lisinopril', pharmacy: 'Main St', callback_number: '+13035550147' },
  });

  const changes = opts.changes ? await pgliteChangeFeed(t.client) : null;
  const app = await createApi({ db: t.db, cipher, auth, log, options: { publicUrl: ORIGIN, demoMode: opts.demoMode, liveStream: opts.liveStream }, voice: opts.voice, now: opts.now, jobs: opts.jobs, knowledge: opts.knowledge, webhooks: opts.webhooks, changes });
  const http = app.getHttpAdapter().getInstance();

  type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  const request = async (method: Method, url: string, o: { cookie?: string; body?: unknown; origin?: string | null } = {}) => {
    const headers: Record<string, string> = {};
    if (o.cookie) headers.cookie = o.cookie;
    if (o.origin !== null) headers.origin = o.origin ?? ORIGIN;
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    return http.inject({ method, url, headers, payload: o.body === undefined ? undefined : JSON.stringify(o.body) });
  };

  const cookieFrom = (setCookie: string | string[] | undefined) =>
    ([] as string[]).concat(setCookie ?? []).map((c) => c.split(';')[0]).join('; ');

  /** Signs in; when enrol is set, also turns on two-factor and returns the upgraded session. */
  async function signIn(email: string, enrol = false) {
    const res = await request('POST', '/api/auth/sign-in/email', { body: { email, password: PASSWORD } });
    if (res.statusCode !== 200) throw new Error(`sign-in failed: ${res.statusCode} ${res.body}`);
    let cookie = cookieFrom(res.headers['set-cookie']);
    if (enrol) {
      const enable = await request('POST', '/api/auth/two-factor/enable', { cookie, body: { password: PASSWORD } });
      if (enable.statusCode !== 200) throw new Error(`2fa enable failed: ${enable.statusCode} ${enable.body}`);
      const verify = await request('POST', '/api/auth/two-factor/verify-totp', { cookie, body: { code: totp(enable.json().totpURI) } });
      if (verify.statusCode !== 200) throw new Error(`2fa verify failed: ${verify.statusCode} ${verify.body}`);
      cookie = cookieFrom(verify.headers['set-cookie']) || cookie;
    }
    return cookie;
  }

  return { t, app, request, signIn, users, patientIds, callId, taskId, close: async () => { await app.close(); await t.close(); } };
}
