// SPDX-License-Identifier: AGPL-3.0-only
import { type ActionRecorder, type Backend, CallAgent, CallState, type Planner } from '@attendra/agent';
import { ClinicConfig, vipRoute } from '@attendra/core';
import type { Logger } from '@attendra/observability';
import { callerNumber, dialledCandidates, maskedHeaders, trimEnd, twilioSignatureValid, twiml } from '@attendra/telephony';
import { CallRunner, EngineRouter, type CallRecorder, type SimulatedEngine, type SimulatedScript, type VoiceEngine } from '@attendra/voice-engine';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { type ActionResult, LiveRegistry, type Numbered } from './live';

/** An incoming phone call: GPT-Live sends a session id, the Realtime API a call id. */
export interface IncomingCall { id: string; type: string; data: { session_id?: string; call_id?: string; sip_headers?: { name: string; value: string }[] } }

export interface VoiceDeps {
  /** Verifies the OpenAI webhook signature and parses the event; throws when it is not genuine. */
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): Promise<IncomingCall>;
  claimDelivery(id: string): Promise<boolean>;
  clinicForNumber(e164: string): Promise<unknown | null>;
  clinicById(clinicId: string): Promise<unknown | null>;
  /** `startedBy` (a staff user id) marks a browser test call and is audited with the call row. */
  openCall(clinicId: string, sessionId: string, fromNumber: string | null, channel: 'phone' | 'web', startedBy?: string): Promise<string>;
  recorderFor(clinicId: string, callId: string): CallRecorder;
  actionsFor(clinicId: string, callId: string): ActionRecorder;
  engine: VoiceEngine;
  backend: Backend;
  planner: Planner;
  log: Logger;
  now?: () => Date;
  /** Webhook deliveries allowed per source address per minute. Defaults to 600. */
  webhookRateLimit?: number;
  /** How long a call on the engine the clinic did not choose waits for its twin on the chosen one. Defaults to 1500 ms. */
  pairWaitMs?: number;
  /** Shared with the API for browser test calls. Without it the internal route does not exist. */
  internalToken?: string;
  /** A browser test call is ended after this long. Defaults to 300. */
  browserCallMaxSeconds?: number;
  /** Browser test calls one clinic may have open at once. Defaults to 2. */
  browserCallsPerClinic?: number;
  /** Open calls and their events, for staff watching live. One is created when none is passed. */
  live?: LiveRegistry;
  /** Seconds between heartbeats on a live stream. Defaults to 15. */
  liveHeartbeatSeconds?: number;
  /**
   * Scripted calls with no audio and no OpenAI, for the demo and the e2e suite. When
   * set, POST /internal/simulated-calls starts one; nothing else changes.
   */
  simulator?: { engine: SimulatedEngine; callFor(clinic: ClinicConfig): { script: SimulatedScript; planner: Planner } | null };
  /**
   * Texts sent to a clinic's number and Twilio's delivery reports, both signed with
   * the Twilio auth token over this service's public address. Without it both routes
   * answer 503.
   */
  sms?: {
    authToken: string;
    publicUrl: string;
    /** A text to a clinic's number. Returns the reply to send, if any. */
    inbound(m: { to: string; from: string; body: string }): Promise<string | undefined>;
    status(job: { clinicId: string; messageSid: string; status: string; errorCode: string | null }): Promise<void>;
  };
}

/** Said near a test call's end: a minute left, then why it stops. */
export const TEST_CALL_MINUTE_LEFT = 'This browser test call ends in about one minute. Finish what you are doing quickly. The next time you speak, tell the caller in a few words that the test call has about a minute left.';
export const TEST_CALL_TIME_UP = 'The browser test call has reached its time limit. Stop the current task. Tell the caller in one short sentence that the test call is ending now because of its time limit, and that they can start another. Then say nothing more.';
/** How long the goodbye may take before the line is closed. */
const TEST_CALL_GOODBYE_MS = 8000;

const WebCall = z.object({ clinicId: z.string().min(1).max(64), userId: z.string().min(1).max(64), sdp: z.string().min(1).max(64 * 1024), maxSeconds: z.number().int().positive().optional() });
const WebCallEnd = z.object({ clinicId: z.string().min(1).max(64) });
const LiveAction = z.object({ clinicId: z.string().min(1).max(64), userId: z.string().min(1).max(64), byName: z.string().trim().max(100).optional(), key: z.string().min(8).max(100) });
const Coach = LiveAction.extend({ note: z.string().trim().min(1).max(300) });
const TakeOver = LiveAction.extend({
  target: z.discriminatedUnion('kind', [z.object({ kind: z.literal('front_desk') }), z.object({ kind: z.literal('number'), number: z.string().regex(/^\+[1-9]\d{7,14}$/) })]),
});
const Simulate = z.object({ clinicId: z.string().min(1).max(64), userId: z.string().min(1).max(64) });

const jsonBody = (raw: unknown) => { try { return JSON.parse(raw as string); } catch { return null; } };
const ACTION_STATUS: Record<Exclude<ActionResult, { ok: true }>['error'], number> = { not_live: 404, already_taken: 409, web_call: 409, emergency_script: 409 };

/** Test calls never text anyone: the number a tester reads out may be a real patient's. What would have gone is recorded as not sent. */
const testCallTexts = (messenger: Backend['messenger']): Backend['messenger'] => ({ sendTemplate: (clinicId, input) => messenger.sendTemplate(clinicId, { ...input, testCall: true }) });

const digest = (s: string) => createHash('sha256').update(s).digest();

// GPT-Live's calls (the second name is deprecated but still delivered during migration), and the Realtime API's
const INCOMING = new Set(['live.transport.incoming', 'live.call.incoming', 'realtime.call.incoming']);
const sessionOf = (e: IncomingCall) => e.data.session_id ?? e.data.call_id ?? '';
// One phone call can arrive twice, once per engine (live_u1_X and rtc_u1_X): the part after the prefix is the call
const callKey = (sessionId: string) => sessionId.replace(/^(?:live|rtc)_/, '');

/**
 * The voice service's HTTP surface: the webhook, a health check, and the internal
 * route the API uses to start browser test calls. The webhook
 * answers 200 fast and handles the call afterwards, because OpenAI retries slow
 * deliveries and a retry must not become a second accept.
 */
export function buildServer(deps: VoiceDeps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  const now = deps.now ?? (() => new Date());
  const running = new Set<Promise<void>>();
  const live = deps.live ?? new LiveRegistry();
  /** Front desk numbers of the calls running now, for a take-over. */
  const frontDesk = new Map<string, string | null>();
  const streams = new Set<{ end(): void }>();

  // keep the exact bytes: the signature is computed over the raw body
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));
  // Twilio posts forms; the signature is over the decoded fields
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))));

  app.get('/healthz', async () => ({ ok: true }));

  // Only deliveries that fail their signature are limited, per address: behind a proxy
  // every request comes from one address, and a flood of forged ones must never turn a
  // real incoming call away. A signed delivery is never limited; checking a signature is
  // cheap, and only a signed one reaches the database. The health check is not limited.
  const forged = new Map<string, { n: number; until: number }>();
  const tooManyForged = (ip: string) => {
    const t = Date.now();
    if (forged.size > 10_000) forged.clear();
    const f = forged.get(ip);
    if (!f || f.until < t) { forged.set(ip, { n: 1, until: t + 60_000 }); return 1 > (deps.webhookRateLimit ?? 600); }
    return ++f.n > (deps.webhookRateLimit ?? 600);
  };
  app.register(async (webhooks) => {
    webhooks.post('/webhooks/openai', async (req, reply) => {
      let event: IncomingCall;
      try {
        event = await deps.verifyWebhook(req.body as string, req.headers);
      } catch {
        if (tooManyForged(req.ip)) return reply.code(429).send({ error: 'too many invalid deliveries' });
        deps.log.warn({ path: '/webhooks/openai' }, 'rejected webhook with an invalid signature');
        return reply.code(400).send({ error: 'invalid signature' });
      }
      if (!INCOMING.has(event.type)) return reply.code(200).send({ ignored: event.type });
      // Claim the delivery (retries) and the session (the same call can arrive as both
      // live.transport.incoming and the deprecated live.call.incoming). First one wins.
      if (!sessionOf(event) || !(await deps.claimDelivery(event.id)) || !(await deps.claimDelivery(`session:${sessionOf(event)}`))) {
        return reply.code(200).send({ duplicate: true });
      }

      track(handleIncoming(event));
      return reply.code(200).send({ accepted: true });
    });

    // Twilio: texts to a clinic's number (STOP, START) and delivery reports. Both answer
    // fast and see only numbers, which are hashed before they are stored.
    const fromTwilio = (req: { url: string; body: unknown; headers: Record<string, unknown> }) => {
      const fields = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, string>;
      const ok = !!deps.sms && twilioSignatureValid(`${trimEnd(deps.sms.publicUrl, '/')}${req.url}`, fields, deps.sms.authToken, req.headers['x-twilio-signature'] as string | undefined);
      return ok ? fields : null;
    };
    webhooks.post('/webhooks/twilio/sms-inbound', async (req, reply) => {
      if (!deps.sms) return reply.code(503).send({ error: 'sms_webhooks_off' });
      const f = fromTwilio(req);
      if (!f) {
        if (tooManyForged(req.ip)) return reply.code(429).send({ error: 'too many invalid deliveries' });
        deps.log.warn({ path: '/webhooks/twilio/sms-inbound' }, 'rejected a Twilio request with an invalid signature'); return reply.code(403).send({ error: 'invalid signature' });
      }
      const message = f.To && f.From ? await deps.sms.inbound({ to: f.To, from: f.From, body: f.Body ?? '' }) : undefined;
      return reply.code(200).header('content-type', 'text/xml').send(twiml(message));
    });
    webhooks.post('/webhooks/twilio/sms-status', async (req, reply) => {
      if (!deps.sms) return reply.code(503).send({ error: 'sms_webhooks_off' });
      const f = fromTwilio(req);
      if (!f) {
        if (tooManyForged(req.ip)) return reply.code(429).send({ error: 'too many invalid deliveries' });
        deps.log.warn({ path: '/webhooks/twilio/sms-status' }, 'rejected a Twilio request with an invalid signature'); return reply.code(403).send({ error: 'invalid signature' });
      }
      const clinicId = (req.query as { clinic?: string }).clinic;
      if (!clinicId || !/^SM[0-9a-f]{32}$/i.test(f.MessageSid ?? '') || !f.MessageStatus) return reply.code(400).send({ error: 'bad_request' });
      await deps.sms.status({ clinicId, messageSid: f.MessageSid!, status: f.MessageStatus, errorCode: /^\d{1,6}$/.test(f.ErrorCode ?? '') ? f.ErrorCode! : null });
      return reply.code(204).send();
    });
  });

  const maxSeconds = deps.browserCallMaxSeconds ?? 300;
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) throw new Error('browserCallMaxSeconds must be a positive number');
  const perClinic = deps.browserCallsPerClinic ?? 2;
  /** Open browser test calls: by call id for ending them, and a count per clinic for the limit. */
  const webCalls = new Map<string, { clinicId: string; sessionId: string }>();
  const openPerClinic = new Map<string, number>();
  const hold = (clinicId: string, by: 1 | -1) => {
    const next = (openPerClinic.get(clinicId) ?? 0) + by;
    if (next > 0) openPerClinic.set(clinicId, next);
    else openPerClinic.delete(clinicId);
  };

  if (deps.internalToken) {
    const expected = digest(`Bearer ${deps.internalToken}`);
    const authorised = (auth: unknown) => typeof auth === 'string' && timingSafeEqual(digest(auth), expected);
    // Only the API calls these. It checks the staff member and the clinic; these routes
    // only check that the caller is the API. The per-clinic limit is what bounds cost.
    app.register(async (internal) => {
      // a backstop only: every request comes from the API, so this is one bucket for all clinics
      await internal.register(rateLimit, { max: 600, timeWindow: 60_000 });

      internal.post('/internal/web-calls', async (req, reply) => {
        if (!authorised(req.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
        let body: z.infer<typeof WebCall>;
        try {
          body = WebCall.parse(JSON.parse(req.body as string));
        } catch {
          return reply.code(400).send({ error: 'invalid body' });
        }
        const stored = await deps.clinicById(body.clinicId);
        if (!stored) return reply.code(404).send({ error: 'no such clinic' });
        const parsed = ClinicConfig.safeParse(stored);
        if (!parsed.success) {
          deps.log.error({ clinic_id: body.clinicId }, 'stored clinic settings are invalid');
          return reply.code(500).send({ error: 'invalid_clinic_config' });
        }
        const clinic = parsed.data;
        if ((openPerClinic.get(clinic.id) ?? 0) >= perClinic) return reply.code(429).send({ error: 'test_call_limit' });

        hold(clinic.id, 1); // before any await, so two requests at once cannot both pass the limit
        let started: { sessionId: string; sdpAnswer: string };
        try {
          started = await deps.engine.startBrowserCall(clinic, body.sdp, now());
        } catch (err) {
          hold(clinic.id, -1);
          deps.log.error({ clinic_id: clinic.id, err }, 'browser call could not start');
          return reply.code(502).send({ error: 'voice_unavailable' });
        }
        const { sessionId } = started;
        let callId: string;
        try {
          callId = await deps.openCall(clinic.id, sessionId, null, 'web', body.userId);
        } catch (err) {
          deps.log.error({ session_id: sessionId, err }, 'browser call setup failed');
          await deps.engine.hangup(sessionId).catch(() => {});
          deps.engine.release?.(sessionId);
          hold(clinic.id, -1);
          return reply.code(500).send({ error: 'setup_failed' });
        }
        webCalls.set(callId, { clinicId: clinic.id, sessionId });
        // the API may ask for less than the usual limit: the clinic's test time left
        const limit = Math.min(body.maxSeconds ?? maxSeconds, maxSeconds);
        track(runCall(clinic, sessionId, callId, null, 'web', { maxSeconds: limit }).finally(() => {
          webCalls.delete(callId);
          hold(clinic.id, -1);
        }));
        return reply.code(201).send({ callId, sdp: started.sdpAnswer, maxSeconds: limit });
      });

      // The dashboard's way out when the browser cannot send session.close itself:
      // the page was closed while connecting, or its data channel never opened.
      internal.post('/internal/web-calls/:callId/end', async (req, reply) => {
        if (!authorised(req.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
        const parsed = WebCallEnd.safeParse((() => { try { return JSON.parse(req.body as string); } catch { return null; } })());
        if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });
        const call = webCalls.get((req.params as { callId: string }).callId);
        if (!call || call.clinicId !== parsed.data.clinicId) return reply.code(404).send({ error: 'no such call' });
        await deps.engine.hangup(call.sessionId).catch((err) => deps.log.warn({ session_id: call.sessionId, err }, 'ending a test call failed'));
        return reply.code(202).send({ ending: true });
      });

      // The calls running now, for one clinic. The API strips the caller's name for roles that may not read calls.
      internal.get('/internal/live', async (req, reply) => {
        if (!authorised(req.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
        const clinicId = (req.query as { clinicId?: string }).clinicId;
        if (!clinicId) return reply.code(400).send({ error: 'clinicId required' });
        return { calls: live.list(clinicId) };
      });

      // One call's events as Server-Sent Events: where it stands, the buffer since
      // Last-Event-ID, then everything new, with a heartbeat so proxies keep it open.
      internal.get('/internal/live/:callId', async (req, reply) => {
        if (!authorised(req.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
        const clinicId = (req.query as { clinicId?: string }).clinicId ?? '';
        const callId = (req.params as { callId: string }).callId;
        if (!live.has(clinicId, callId)) return reply.code(404).send({ error: 'not_live' });
        const last = Number(req.headers['last-event-id']);
        reply.hijack();
        const res = reply.raw;
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        let open = true;
        const stream = { end: () => { if (open) { open = false; res.end(); } } };
        streams.add(stream);
        const write = (n: Numbered) => {
          if (!open) return;
          res.write(`${n.id ? `id: ${n.id}\n` : ''}event: ${n.event.type}\ndata: ${JSON.stringify(n.event)}\n\n`);
          if (n.event.type === 'ended') stream.end();
        };
        const unsubscribe = live.subscribe(clinicId, callId, Number.isInteger(last) && last > 0 ? last : null, write) ?? (() => {});
        const beat = setInterval(() => { if (open) res.write(': heartbeat\n\n'); }, (deps.liveHeartbeatSeconds ?? 15) * 1000);
        res.on('close', () => { open = false; clearInterval(beat); unsubscribe(); streams.delete(stream); });
      });

      const answer = (reply: { code(n: number): { send(b: unknown): unknown } }, r: ActionResult) =>
        r.ok ? reply.code(r.repeat ? 200 : 202).send({ ok: true, repeat: r.repeat }) : reply.code(ACTION_STATUS[r.error]).send({ error: r.error, by: r.by });

      internal.post('/internal/live/:callId/coach', async (req, reply) => {
        if (!authorised(req.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
        const body = Coach.safeParse(jsonBody(req.body));
        if (!body.success) return reply.code(400).send({ error: 'invalid body' });
        return answer(reply, await live.coach(body.data.clinicId, (req.params as { callId: string }).callId, body.data.key, body.data.note, body.data.byName ?? null));
      });

      internal.post('/internal/live/:callId/take-over', async (req, reply) => {
        if (!authorised(req.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
        const body = TakeOver.safeParse(jsonBody(req.body));
        if (!body.success) return reply.code(400).send({ error: 'invalid body' });
        const callId = (req.params as { callId: string }).callId;
        const uri = body.data.target.kind === 'number' ? `tel:${body.data.target.number}` : frontDesk.get(callId) ?? null;
        if (!uri) return live.has(body.data.clinicId, callId) ? reply.code(409).send({ error: 'no_front_desk' }) : reply.code(404).send({ error: 'not_live' });
        return answer(reply, await live.claim(body.data.clinicId, callId, body.data.key, body.data.userId, 'take_over', (c) => c.takeOver(uri, body.data.byName ?? null)));
      });

      internal.post('/internal/live/:callId/end', async (req, reply) => {
        if (!authorised(req.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
        const body = LiveAction.safeParse(jsonBody(req.body));
        if (!body.success) return reply.code(400).send({ error: 'invalid body' });
        return answer(reply, await live.claim(body.data.clinicId, (req.params as { callId: string }).callId, body.data.key, body.data.userId, 'end', (c) => c.end(body.data.byName ?? null)));
      });

      // A scripted call through the real agent, tools and database, with no audio and
      // no model: for the demo and the e2e suite. Recorded as a browser test call.
      if (deps.simulator) {
        const simulator = deps.simulator;
        internal.post('/internal/simulated-calls', async (req, reply) => {
          if (!authorised(req.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
          const body = Simulate.safeParse(jsonBody(req.body));
          if (!body.success) return reply.code(400).send({ error: 'invalid body' });
          const stored = await deps.clinicById(body.data.clinicId);
          const parsed = stored ? ClinicConfig.safeParse(stored) : null;
          if (!parsed?.success) return reply.code(404).send({ error: 'no such clinic' });
          const call = simulator.callFor(parsed.data);
          if (!call) return reply.code(404).send({ error: 'no_simulated_call' });
          const sessionId = simulator.engine.create(call.script);
          const callId = await deps.openCall(parsed.data.id, sessionId, null, 'web', body.data.userId);
          track(runCall(parsed.data, sessionId, callId, null, 'web', { engine: simulator.engine, planner: call.planner, onReady: () => simulator.engine.play(sessionId) }));
          return reply.code(201).send({ callId });
        });
      }
    });
  }

  function track(task: Promise<void>) {
    running.add(task);
    void task.finally(() => running.delete(task));
  }

  /** Runs an accepted conversation to the end, whichever way it came in. */
  async function runCall(clinic: ClinicConfig, sessionId: string, callId: string, from: string | null, channel: 'phone' | 'web',
    opts: { engine?: VoiceEngine; planner?: Planner; onReady?: () => void; maxSeconds?: number; vipUri?: string } = {}) {
    const web = channel === 'web';
    const engine = opts.engine ?? deps.engine;
    const timers: NodeJS.Timeout[] = [];
    let closed = false;
    let hungUp = false;
    let agent: CallAgent | null = null;
    const hangup = () => { hungUp = true; return engine.hangup(sessionId).catch(() => {}); };
    try {
      const backend = web ? { ...deps.backend, messenger: testCallTexts(deps.backend.messenger) } : deps.backend;
      // before each request the agent reads the clinic again, so the doctors and their hours are the ones in the dashboard now
      const reloadClinic = async () => {
        const parsed = ClinicConfig.safeParse(await deps.clinicById(clinic.id));
        return parsed.success ? parsed.data : null;
      };
      agent = new CallAgent(new CallState(), { clinic, reloadClinic, callId, callerNumber: from, now, log: deps.log, channel }, backend, opts.planner ?? deps.planner, deps.log, deps.actionsFor(clinic.id, callId));
      const sideband = engine.attach(sessionId);
      sideband.onEvent((e) => { if (e.type === 'session.closed') closed = true; });
      const runner = new CallRunner(sessionId, engine, sideband, agent, deps.recorderFor(clinic.id, callId), deps.log);
      if (web) {
        const limit = opts.maxSeconds ?? maxSeconds;
        // a minute before the end the caller hears so, and at the end the assistant says why it
        // stops: a test call never just goes quiet
        if (limit > 90) {
          timers.push(setTimeout(() => {
            void runner.act([{ type: 'instructions', delegationId: null, content: TEST_CALL_MINUTE_LEFT }]).catch(() => {});
          }, (limit - 60) * 1000));
        }
        // the goodbye takes a few seconds, never longer than the call itself was allowed
        const goodbye = Math.min(TEST_CALL_GOODBYE_MS, limit * 1000);
        timers.push(setTimeout(() => {
          deps.log.info({ session_id: sessionId }, 'test call reached its time limit');
          void runner.act([{ type: 'instructions', delegationId: null, content: TEST_CALL_TIME_UP }, { type: 'hangup', afterMs: goodbye }]).catch(() => hangup());
        }, limit * 1000));
        // whatever the goodbye did, the call is over a little later
        timers.push(setTimeout(() => { void hangup(); }, limit * 1000 + goodbye + 5000));
        // if the session ignores the close, stop listening anyway so the call counts as over
        timers.push(setTimeout(() => sideband.close(), (limit + 30) * 1000));
      }
      const a = agent;
      // staff watching live see every event; their actions go through the runner like the agent's own
      frontDesk.set(callId, clinic.routing.find((r) => r.target === 'front_desk')?.uri ?? null);
      live.open(callId, { clinicId: clinic.id, channel, startedAt: now() }, {
        coach: (note, by) => runner.act(a.coach(note, by)),
        takeOver: (uri, by) => runner.act(a.takeOver(uri, by)),
        end: (by) => runner.act(a.endByStaff(by)),
        canEnd: () => a.canEndByStaff(),
      });
      a.observer = (e) => live.publish(callId, e);
      deps.log.info({ session_id: sessionId, clinic_id: clinic.id, call_id: callId, channel }, 'call accepted');
      const done = runner.start();
      // a VIP caller hears the greeting, then goes straight to the front desk
      if (opts.vipUri) await runner.act(a.vip(opts.vipUri));
      opts.onReady?.();
      await done;
    } catch (err) {
      deps.log.error({ session_id: sessionId, err }, 'call failed');
      await Promise.resolve().then(hangup);
    } finally {
      timers.forEach(clearTimeout);
      live.end(callId, agent?.state.outcome ?? 'abandoned');
      frontDesk.delete(callId);
      // A phone call ends with the line. A browser keeps talking after our sideband drops,
      // with no tools, recording or time limit, so end it explicitly.
      if (web && !closed && !hungUp) await hangup();
      // phone calls too: the engine and the router keep a little per call until released
      engine.release?.(sessionId);
    }
  }

  /**
   * Never leaves a caller in dead air: a failure before accepting rejects the call
   * with SIP 503 (the carrier plays its own message), a failure after accepting hangs up.
   */
  async function handleIncoming(event: IncomingCall) {
    const sessionId = sessionOf(event);
    const headers = event.data.sip_headers ?? [];
    // OpenAI decides which kind of call it is (a GPT-Live or a Realtime one): it is answered with that engine
    const came = event.type.startsWith('realtime.') ? 'gpt-realtime' : 'gpt-live';
    const router = deps.engine instanceof EngineRouter ? deps.engine : null;
    const via = router ? router.named(came) : deps.engine;
    let accepted = false;
    try {
      if (!via) {
        deps.log.error({ session_id: sessionId, engine: came }, 'a call came in for an engine this server does not run; rejecting with 503');
        await deps.engine.reject(sessionId, 503);
        return;
      }
      let stored: unknown = null;
      for (const n of dialledCandidates(headers)) if ((stored = await deps.clinicForNumber(n))) break;
      // OpenAI sends one call once per engine: the clinic's engine answers it (GPT-Live unless it chose
      // another), the twin stays silent; a twin that waited and found no answer takes the call itself
      const chosen = (stored as { voiceEngine?: string } | null)?.voiceEngine ?? 'gpt-live';
      if (came !== chosen) await new Promise((r) => setTimeout(r, deps.pairWaitMs ?? 1500));
      if (!(await deps.claimDelivery(`call:${callKey(sessionId)}`))) {
        deps.log.info({ session_id: sessionId }, 'the same call came in for the other engine, which answers it');
        return;
      }
      if (!stored) {
        deps.log.warn({ session_id: sessionId, sip_headers: maskedHeaders(headers) }, 'no clinic for the dialled number; rejecting with 404');
        await via.reject(sessionId, 404);
        return;
      }
      const clinic = ClinicConfig.parse(stored);
      const from = callerNumber(headers);
      if (router && clinic.voiceEngine && clinic.voiceEngine !== came) {
        deps.log.warn({ session_id: sessionId, clinic_id: clinic.id, chosen: clinic.voiceEngine, came }, 'the clinic chose another engine, but OpenAI sent this kind of call: answering with the engine it came on');
      }
      if (router) await router.acceptWith(via, sessionId, clinic, now());
      else await deps.engine.accept(sessionId, clinic, now());
      accepted = true;
      const callId = await deps.openCall(clinic.id, sessionId, from, 'phone');
      const vip = vipRoute(clinic, from, now());
      if (vip) deps.log.info({ session_id: sessionId, clinic_id: clinic.id, call_id: callId }, 'VIP caller: transferring to the front desk');
      await runCall(clinic, sessionId, callId, from, 'phone', { vipUri: vip?.uri });
    } catch (err) {
      deps.log.error({ session_id: sessionId, err }, 'call setup failed');
      // best effort: the call is already failing, and a second error must not escape
      await Promise.resolve().then(() => (accepted ? deps.engine.hangup(sessionId) : (via ?? deps.engine).reject(sessionId, 503))).catch(() => {});
    }
  }

  app.addHook('onClose', async () => {
    for (const s of streams) s.end();
    await Promise.allSettled(running);
  });
  return app;
}
