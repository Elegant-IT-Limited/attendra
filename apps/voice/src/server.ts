// SPDX-License-Identifier: AGPL-3.0-only
import { type ActionRecorder, type Backend, CallAgent, CallCache, cachedBackend, CallState, type Planner, warmPatient } from '@attendra/agent';
import { ClinicConfig, openAiEngineOf, resolveTransfer, VOICE_ENGINES, type VoiceEngineName, type VoiceFlow, vipRoute } from '@attendra/core';
import { type Alerter, isOpenAiQuotaError, type Logger } from '@attendra/observability';
import { callerNumber, dialledCandidates, maskedHeaders, type PhoneCallRef, type PhoneLine, SPEND_ALERT_PATH, spendAlertText, trimEnd, twilioCallSid, twilioSignatureValid, twiml } from '@attendra/telephony';
import { callerContext, CallMarks, CallRunner, EngineRouter, type CallRecorder, type SimulatedEngine, type SimulatedScript, type VoiceEngine, pausedOpening, vipOpening } from '@attendra/voice-engine';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { type ActionResult, LiveRegistry, type Numbered } from './live';
import { mintToolToken, readToolToken, TOOL_TOKEN_MAX_MS } from './tool-tokens';
import { registerVapi, type VapiOptions } from './vapi';

/** How long a browser test call's close waits for the page's own end before it counts as a dropped line. */
export const WEB_CLOSE_GRACE_MS = 2000;

/** Said when OpenAI refuses for credit or quota: every call stops until it is topped up. */
export const OPENAI_QUOTA_TEXT = 'OpenAI refused a request: the credit or quota is used up. Calls fail until it is topped up.';

/** An incoming phone call: GPT-Live sends a session id, the Realtime API a call id. */
export interface IncomingCall { id: string; type: string; data: { session_id?: string; call_id?: string; sip_headers?: { name: string; value: string }[] } }

export interface VoiceDeps {
  /** Verifies the OpenAI webhook signature and parses the event; throws when it is not genuine. */
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): Promise<IncomingCall>;
  claimDelivery(id: string): Promise<boolean>;
  clinicForNumber(e164: string): Promise<unknown | null>;
  clinicById(clinicId: string): Promise<unknown | null>;
  /**
   * `startedBy` (a staff user id) marks a browser test call and is audited with the call row.
   * `calledAsLast4`: a browser test call started as a number ("Call as") keeps only its last four digits.
   */
  openCall(clinicId: string, sessionId: string, fromNumber: string | null, channel: 'phone' | 'web', startedBy?: string, calledAsLast4?: string, how?: { engine?: VoiceEngineName; voiceFlow?: VoiceFlow }): Promise<string>;
  /** Where alerts go (Slack): a call turned away or failed. */
  alerts?: Alerter;
  /** This number's last calls to the clinic, as lines for the backend; null when there are none. */
  historyFor?(clinicId: string, fromNumber: string, callId: string): Promise<string | null>;
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
  /** Webhook deliveries per address per minute, before the signature check. Defaults to 1,200. */
  webhookRouteLimit?: number;
  /** A browser test call is ended after this long. Defaults to 900 (15 minutes), still capped by the clinic's test minutes left. */
  browserCallMaxSeconds?: number;
  /**
   * Vapi, a location's backup engine (batch 6): how /webhooks/vapi/v1/events checks a location's own secret, counts the
   * Vapi calls live at once, and reaches a call's control URL. Without it the route does not exist.
   */
  vapi?: VapiOptions;
  /**
   * gpt-realtime on the tools path: run a likely lookup before the reply (round 2). Defaults to off: on real audio it
   * saved no time (the wait for the caller's words costs about what it saves), so it stays behind this switch.
   */
  lookupAhead?: boolean;
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
  /**
   * The phone side of a phone call (Twilio's call status): asked when a call's line closes with no end the runner knows
   * of, so a caller's hang-up is not counted as a drop (note 48). Without it such a close is a drop, as before.
   */
  phoneLine?: PhoneLine;
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

/**
 * `callAs`: the number a browser test call is started as ("Call as"), checked by the API (staff of the
 * clinic; a record's number needs patients:read). It becomes that call's caller ID and nothing else's:
 * only this internal route reads it, and a phone call's caller ID only ever comes from the carrier.
 */
const WebCall = z.object({
  clinicId: z.string().min(1).max(64), userId: z.string().min(1).max(64), sdp: z.string().min(1).max(64 * 1024), maxSeconds: z.number().int().positive().optional(),
  callAs: z.string().regex(/^\+[1-9]\d{7,14}$/).optional(),
});
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

/** How a clinic's calls are answered: its operator's choice, else the planner (batch 1a switches clinics one at a time). */
const flowOf = (clinic: ClinicConfig): VoiceFlow => clinic.voiceFlow ?? 'planner';
/** The engine's name as the call row keeps it; none for an engine the row does not know (the simulator). */
const engineName = (engine: VoiceEngine | null | undefined): VoiceEngineName | undefined =>
  engine && (VOICE_ENGINES as readonly string[]).includes(engine.name) ? engine.name as VoiceEngineName : undefined;

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
  /** The tools-path calls running now, by call id: the tools API's HTTP surface answers their tool calls (batch 1a). */
  const toolLines = new Map<string, { clinicId: string; runner: CallRunner; token: string }>();

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
    // A generous limit per address on every webhook, in front of the signature check and any database work, so a flood
    // is cut early. Far above any real call volume (behind one proxy every delivery shares an address); the forged-
    // delivery limit above still applies on top.
    await webhooks.register(rateLimit, { max: deps.webhookRouteLimit ?? 1200, timeWindow: 60_000, keyGenerator: (req) => req.ip });
    webhooks.post('/webhooks/openai', async (req, reply) => {
      const receivedAt = Date.now();
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

      track(handleIncoming(event, receivedAt));
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
    // Twilio: a day's spend passed one of the worker's usage triggers (texts, the whole bill)
    webhooks.post(SPEND_ALERT_PATH, async (req, reply) => {
      if (!deps.sms) return reply.code(503).send({ error: 'sms_webhooks_off' });
      const f = fromTwilio(req);
      if (!f) {
        if (tooManyForged(req.ip)) return reply.code(429).send({ error: 'too many invalid deliveries' });
        deps.log.warn({ path: SPEND_ALERT_PATH }, 'rejected a Twilio request with an invalid signature'); return reply.code(403).send({ error: 'invalid signature' });
      }
      if (!/^UT[0-9a-f]{32}$/i.test(f.UsageTriggerSid ?? '')) return reply.code(400).send({ error: 'bad_request' });
      deps.log.warn({ category: f.UsageCategory, current: f.CurrentValue, trigger: f.TriggerValue }, 'Twilio spend passed an alert line');
      deps.alerts?.alert(`spend_${(f.UsageCategory ?? 'twilio').replace(/[^a-z]/gi, '')}`, spendAlertText(f));
      return reply.code(204).send();
    });
  });

  const maxSeconds = deps.browserCallMaxSeconds ?? 900;
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) throw new Error('browserCallMaxSeconds must be a positive number');
  const perClinic = deps.browserCallsPerClinic ?? 2;
  /** Open browser test calls: by call id for ending them, and a count per clinic for the limit. */
  const webCalls = new Map<string, { clinicId: string; sessionId: string }>();
  // the runner of each browser test call, so the page's End tells it the caller ended the call (not a dropped line)
  const webRunners = new Map<string, Pick<CallRunner, 'callerEnded'>>();
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

      // The tools API's HTTP surface (batch 1a): the same tools the voice calls on the sideband, for an engine that runs
      // outside this process (Vapi's tool server, batch 6). The bearer is the call's own token, minted at its start; the
      // call must still be live. The result is the same JSON a sideband tool call gets back.
      internal.post('/tools/v1/:tool', async (req, reply) => {
        const key = deps.internalToken!;
        const bearer = typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
        const t = readToolToken(key, bearer);
        const line = t ? toolLines.get(t.callId) : undefined;
        if (!t || !line || line.clinicId !== t.clinicId || line.token !== bearer) return reply.code(401).send({ error: 'unauthorized' });
        const body = jsonBody(req.body) as { call_id?: unknown; arguments?: unknown } | null;
        const tool = (req.params as { tool: string }).tool;
        if (!body || typeof body !== 'object' || !/^[a-z_]{2,40}$/.test(tool)) return reply.code(400).send({ error: 'invalid body' });
        const callId = typeof body.call_id === 'string' && body.call_id.length <= 100 ? body.call_id : `http_${randomUUID()}`;
        const output = await line.runner.callTool(callId, tool, JSON.stringify(body.arguments ?? {}));
        if (output === null) return reply.code(409).send({ error: 'already_answered' });
        return reply.code(200).header('content-type', 'application/json').send(output);
      });

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
        const marks = new CallMarks();
        let started: { sessionId: string; sdpAnswer: string };
        try {
          marks.mark('accept_sent');
          // with a number to call as, the voice has caller ID: its number line, not "there is no caller ID"
          started = await deps.engine.startBrowserCall(clinic, body.sdp, now(), { callerNumber: body.callAs ?? null, flow: flowOf(clinic) });
          marks.mark('accepted');
        } catch (err) {
          hold(clinic.id, -1);
          deps.log.error({ clinic_id: clinic.id, err }, 'browser call could not start');
          return reply.code(502).send({ error: 'voice_unavailable' });
        }
        const { sessionId } = started;
        let callId: string;
        try {
          // the call row never holds the number: a client's calls from it must not fill with tests
          const engine = deps.engine instanceof EngineRouter ? deps.engine.engineFor(clinic) : deps.engine;
          callId = await deps.openCall(clinic.id, sessionId, null, 'web', body.userId, body.callAs?.slice(-4), { engine: engineName(engine), voiceFlow: flowOf(clinic) });
        } catch (err) {
          deps.log.error({ session_id: sessionId, err }, 'browser call setup failed');
          await deps.engine.hangup(sessionId).catch(() => {});
          deps.engine.release?.(sessionId);
          hold(clinic.id, -1);
          return reply.code(500).send({ error: 'setup_failed' });
        }
        marks.mark('call_opened');
        webCalls.set(callId, { clinicId: clinic.id, sessionId });
        // the API may ask for less than the usual limit: the clinic's test time left
        const limit = Math.min(body.maxSeconds ?? maxSeconds, maxSeconds);
        track(runCall(clinic, sessionId, callId, body.callAs ?? null, 'web', { maxSeconds: limit, marks }).finally(() => {
          webCalls.delete(callId);
          webRunners.delete(callId);
          hold(clinic.id, -1);
        }));
        return reply.code(201).send({ callId, sdp: started.sdpAnswer, maxSeconds: limit, calledAsLast4: body.callAs ? body.callAs.slice(-4) : null });
      });

      // The usual time limit for one test call, so the dashboard can say it before the call. This config is its one source.
      internal.get('/internal/web-calls/limits', async (req, reply) => {
        if (!authorised(req.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
        return { maxSeconds };
      });

      // The dashboard's way out when the browser cannot send session.close itself:
      // the page was closed while connecting, or its data channel never opened.
      internal.post('/internal/web-calls/:callId/end', async (req, reply) => {
        if (!authorised(req.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
        const parsed = WebCallEnd.safeParse((() => { try { return JSON.parse(req.body as string); } catch { return null; } })());
        if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });
        const id = (req.params as { callId: string }).callId;
        const call = webCalls.get(id);
        if (!call || call.clinicId !== parsed.data.clinicId) return reply.code(404).send({ error: 'no such call' });
        // the caller ended it: the line closing next is a hang-up, whichever arrives first (2026-11-11)
        webRunners.get(id)?.callerEnded();
        await deps.engine.hangup(call.sessionId).catch((err: unknown) => {
          // the page closed the line itself a moment before: the call is already over, which is what was asked
          if ((err as { status?: number }).status === 404) deps.log.info({ session_id: call.sessionId }, 'the test call had already ended');
          else deps.log.warn({ session_id: call.sessionId, err }, 'ending a test call failed');
        });
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
    opts: { engine?: VoiceEngine; planner?: Planner; onReady?: () => void; maxSeconds?: number; vipUri?: string; paused?: { uri: string | null }; marks?: CallMarks; phone?: PhoneCallRef } = {}) {
    const web = channel === 'web';
    const engine = opts.engine ?? deps.engine;
    const marks = opts.marks ?? new CallMarks();
    const timers: NodeJS.Timeout[] = [];
    let closed = false;
    let hungUp = false;
    let agent: CallAgent | null = null;
    let cacheStats: CallCache | null = null;
    const hangup = () => { hungUp = true; return engine.hangup(sessionId).catch(() => {}); };
    // what an alert about this call names: the clinic, and the call it links to
    const where = { clinicId: clinic.id, clinicName: clinic.name, callId };
    try {
      const plain = web ? { ...deps.backend, messenger: testCallTexts(deps.backend.messenger) } : deps.backend;
      // the tools path reads through one cache per call: the schedule read as the call starts, the household's visits
      // once the pet is found, so a lookup answers from memory (the preload). The simulator keeps the planner's way
      const tools = flowOf(clinic) === 'tools' && !opts.planner;
      const cache = tools ? new CallCache() : null;
      const backend = cache ? cachedBackend(plain, cache) : plain;
      cacheStats = cache;
      if (cache) cache.warmSchedule(plain.scheduler, clinic.id, clinic.providers.map((p) => p.id), now());
      // before each request the agent reads the clinic again, so the doctors and their hours are the ones in the dashboard now
      const reloadClinic = async () => {
        const parsed = ClinicConfig.safeParse(await deps.clinicById(clinic.id));
        return parsed.success ? parsed.data : null;
      };
      // a caller ringing back is helped from where they left off; a failed read never holds up the call, and neither
      // does a slow one: the sideband attaches and the greeting goes out while the records are read. A browser test
      // call has a number only when staff started it as one ("Call as"), and is then read the same way.
      const historyRead: Promise<string | null> = from && deps.historyFor ? deps.historyFor(clinic.id, from, callId).catch((err: unknown) => {
        deps.log.warn({ session_id: sessionId, err: { message: (err as Error).message } }, 'could not read the caller\'s earlier calls');
        return null;
      }) : Promise.resolve(null);
      agent = new CallAgent(new CallState(), { clinic, reloadClinic, callId, callerNumber: from, history: null, now, log: deps.log, channel,
        onSlow: (ms) => deps.alerts?.alert('slow_answer', `A caller waited ${Math.round(ms / 1000)} s for an answer.`, where),
        onTimeout: (ms) => deps.alerts?.alert('answer_timeout', `An answer took ${Math.round(ms / 1000)} s, past the limit: the caller was offered a callback.`, where),
        // OpenAI out of credit stops every call: it pages at once, not as one more failed answer
        onError: (err) => { if (isOpenAiQuotaError(err)) deps.alerts?.alert('openai_quota', OPENAI_QUOTA_TEXT, where); } }, backend, opts.planner ?? deps.planner, deps.log, deps.actionsFor(clinic.id, callId));
      if (tools) {
        // a yes is read across the caller's pieces ("Yes." "Hello, are you there?"), and the pet's visits are read ahead
        agent.state.answersAcrossPieces = true;
        agent.onPatientFound = (patientId) => warmPatient(backend, clinic.id, patientId, now());
      }
      const sideband = engine.attach(sessionId);
      marks.mark('attached');
      sideband.onEvent((e) => { if (e.type === 'session.closed') closed = true; });
      const runner = new CallRunner(sessionId, engine, sideband, agent, deps.recorderFor(clinic.id, callId), deps.log, marks,
        deps.alerts ? { alert: (kind, text) => deps.alerts!.alert(kind, text, where), where } : undefined);
      // gpt-realtime on the tools path waits for our go once a pet is found, so a lookup runs before its reply (round 2)
      runner.manualTurns = tools && (deps.lookupAhead ?? false) && engine.sessionInfo?.(sessionId)?.engine === 'gpt-realtime';
      // a phone call whose line closes with no end known: the phone side says whether it was hung up (note 48)
      if (!web && deps.phoneLine && opts.phone) { const line = deps.phoneLine; const ref = opts.phone; runner.phoneLineEnded = () => line.ended(ref); }
      if (web) {
        // the page ends a test call by asking our API as it closes the line: either can arrive first
        webRunners.set(callId, runner);
        runner.closeGraceMs = WEB_CLOSE_GRACE_MS;
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
      // a tools-path call can be answered over HTTP too, with its own token (the tools API's second surface)
      if (tools && deps.internalToken) toolLines.set(callId, { clinicId: clinic.id, runner, token: mintToolToken(deps.internalToken, { callId, clinicId: clinic.id, expiresAt: Date.now() + TOOL_TOKEN_MAX_MS }) });
      // staff watching live see every event; their actions go through the runner like the agent's own
      frontDesk.set(callId, clinic.routing.find((r) => r.target === 'front_desk')?.uri ?? null);
      // a phone caller who never hears the assistant goes to the front desk (or the call ends) instead of waiting in silence
      runner.silentStartUri = channel === 'phone' ? frontDesk.get(callId) ?? null : null;
      live.open(callId, { clinicId: clinic.id, channel, startedAt: now() }, {
        coach: (note, by) => runner.act(a.coach(note, by)),
        takeOver: (uri, by) => runner.act(a.takeOver(uri, by)),
        end: (by) => runner.act(a.endByStaff(by)),
        canEnd: () => a.canEndByStaff(),
      });
      a.observer = (e) => live.publish(callId, e);
      // the engine and the voice the session was created with: set once, never changed in the call
      const created = engine.sessionInfo?.(sessionId);
      deps.log.info({ session_id: sessionId, clinic_id: clinic.id, call_id: callId, channel, engine: created?.engine ?? engine.name, voice: created?.voice ?? null, flow: tools ? 'tools' : 'planner' }, 'call accepted');
      const done = runner.start();
      const history = await historyRead;
      marks.mark('history');
      a.setHistory(history);
      // the clinic's assistant is paused: a short line, then the front desk or the end of the call
      if (opts.paused) await runner.act(a.paused(opts.paused.uri));
      // a VIP caller hears their hello, then goes straight to the front desk
      else if (opts.vipUri) await runner.act(a.vip(opts.vipUri));
      // what caller ID would show a front desk: how often this number called, and the one name on file
      else {
        const known = callerContext(history, clinic.industry);
        if (known) await runner.act([{ type: 'instructions', delegationId: null, content: known }]);
      }
      opts.onReady?.();
      await done;
    } catch (err) {
      deps.log.error({ session_id: sessionId, err }, 'call failed');
      await Promise.resolve().then(hangup);
    } finally {
      timers.forEach(clearTimeout);
      toolLines.delete(callId);
      live.end(callId, agent?.state.outcome ?? 'abandoned');
      frontDesk.delete(callId);
      // A phone call ends with the line. A browser keeps talking after our sideband drops,
      // with no tools, recording or time limit, so end it explicitly.
      if (web && !closed && !hungUp) await hangup();
      // phone calls too: the engine and the router keep a little per call until released
      engine.release?.(sessionId);
      if (cacheStats) deps.log.info({ session_id: sessionId, call_id: callId, hits: cacheStats.hits, misses: cacheStats.misses }, 'call cache');
    }
  }

  /**
   * Never leaves a caller in dead air: a failure before accepting rejects the call
   * with SIP 503 (the carrier plays its own message), a failure after accepting hangs up.
   */
  async function handleIncoming(event: IncomingCall, receivedAt = Date.now()) {
    const marks = new CallMarks(receivedAt);
    const sessionId = sessionOf(event);
    const headers = event.data.sip_headers ?? [];
    // OpenAI decides which kind of call it is (a GPT-Live or a Realtime one): it is answered with that engine
    const came = event.type.startsWith('realtime.') ? 'gpt-realtime' : 'gpt-live';
    const router = deps.engine instanceof EngineRouter ? deps.engine : null;
    const via = router ? router.named(came) : deps.engine;
    let accepted = false;
    // the clinic and call, once known: a failed set-up names them in its alert
    let setupClinic: ClinicConfig | null = null;
    let setupCallId: string | undefined;
    try {
      if (!via) {
        deps.log.error({ session_id: sessionId, engine: came }, 'a call came in for an engine this server does not run; rejecting with 503');
        deps.alerts?.alert('call_rejected', `A call came in for the ${came} engine, which this server does not run: turned away (SIP 503).`);
        await deps.engine.reject(sessionId, 503);
        return;
      }
      let stored: unknown = null;
      for (const n of dialledCandidates(headers)) if ((stored = await deps.clinicForNumber(n))) break;
      // OpenAI sends one call once per engine: the clinic's engine answers it (GPT-Live unless it chose
      // another), the twin stays silent; a twin that waited and found no answer takes the call itself
      // a location on Vapi whose call still reaches us (Vapi full or down: Twilio's fallback to this path) is answered by
      // the engine it had before it was switched (batch 6), as any other call
      const chosen = (stored ? openAiEngineOf(stored as Pick<ClinicConfig, 'voiceEngine' | 'vapi'>) : undefined) ?? 'gpt-live';
      if (came !== chosen) await new Promise((r) => setTimeout(r, deps.pairWaitMs ?? 1500));
      if (!(await deps.claimDelivery(`call:${callKey(sessionId)}`))) {
        deps.log.info({ session_id: sessionId }, 'the same call came in for the other engine, which answers it');
        return;
      }
      if (!stored) {
        deps.log.warn({ session_id: sessionId, sip_headers: maskedHeaders(headers) }, 'no clinic for the dialled number; rejecting with 404');
        deps.alerts?.alert('call_rejected', `A call matched no clinic and was turned away (SIP 404). Dialled: ${dialledCandidates(headers)[0] ?? 'unknown'}.`);
        await via.reject(sessionId, 404);
        return;
      }
      const clinic = ClinicConfig.parse(stored);
      setupClinic = clinic;
      const from = callerNumber(headers, clinic);
      if (router && openAiEngineOf(clinic) && openAiEngineOf(clinic) !== came) {
        deps.log.warn({ session_id: sessionId, clinic_id: clinic.id, chosen: openAiEngineOf(clinic), came }, 'the clinic chose another engine, but OpenAI sent this kind of call: answering with the engine it came on');
      }
      if (clinic.voiceEngine === 'vapi') deps.log.info({ session_id: sessionId, clinic_id: clinic.id, engine: came }, 'a call for a location on Vapi reached our own SIP path (overflow): answering it here');
      // a paused assistant (the clinic's plan) puts every caller through to the front desk while it takes
      // transfers, or tells them when to call back; a VIP is greeted by name and put through
      const front = clinic.answeringPaused ? resolveTransfer(clinic, 'front_desk', now()) : null;
      const paused = front ? { uri: front.ok ? front.uri : null } : undefined;
      const vip = paused ? null : vipRoute(clinic, from, now());
      const opening = paused ? pausedOpening(clinic, !!paused.uri) : vip ? vipOpening(clinic, vip.name) : undefined;
      marks.mark('accept_sent');
      // the caller ID goes in from the start: the voice asks the number question itself, for a visit only (2026-11-14)
      // how its turns are answered is set with the session: the planner, or the tools API (the clinic's switch, batch 1a)
      if (router) await router.acceptWith(via, sessionId, clinic, now(), opening, { callerNumber: from, flow: flowOf(clinic) });
      else await deps.engine.accept(sessionId, clinic, now(), opening, { callerNumber: from, flow: flowOf(clinic) });
      accepted = true;
      marks.mark('accepted');
      const callId = await deps.openCall(clinic.id, sessionId, from, 'phone', undefined, undefined, { engine: engineName(via), voiceFlow: flowOf(clinic) });
      setupCallId = callId;
      marks.mark('call_opened');
      if (paused) deps.log.info({ session_id: sessionId, clinic_id: clinic.id, call_id: callId, transfer: !!paused.uri }, 'the assistant is paused: the caller goes to the front desk or hears when to call back');
      else if (vip) deps.log.info({ session_id: sessionId, clinic_id: clinic.id, call_id: callId }, 'VIP caller: transferring to the front desk');
      await runCall(clinic, sessionId, callId, from, 'phone', { vipUri: vip?.uri, paused, marks, phone: { callSid: twilioCallSid(headers), to: clinic.phoneNumbers.find((n) => dialledCandidates(headers).includes(n)) ?? dialledCandidates(headers)[0] ?? null, from, startedAt: new Date(receivedAt) } });
    } catch (err) {
      deps.log.error({ session_id: sessionId, err }, 'call setup failed');
      const where = setupClinic ? { clinicId: setupClinic.id, clinicName: setupClinic.name, callId: setupCallId } : undefined;
      if (isOpenAiQuotaError(err)) deps.alerts?.alert('openai_quota', OPENAI_QUOTA_TEXT, where);
      deps.alerts?.alert('call_failed', `A call could not be set up${accepted ? ' after it was answered' : ' and was turned away'}: ${(err as Error)?.message?.slice(0, 120) ?? 'unknown error'}.`, where);
      // best effort: the call is already failing, and a second error must not escape
      await Promise.resolve().then(() => (accepted ? deps.engine.hangup(sessionId) : (via ?? deps.engine).reject(sessionId, 503))).catch(() => {});
    }
  }

  if (deps.vapi) {
    registerVapi(app, { ...deps.vapi, clinicById: deps.clinicById, openCall: deps.openCall, recorderFor: deps.recorderFor, actionsFor: deps.actionsFor, backend: deps.backend, planner: deps.planner, log: deps.log, alerts: deps.alerts, now });
  }
  // tests read a live tools-path call's token here; nothing else does, and it is never logged
  app.decorate('toolTokenFor', (callId: string) => toolLines.get(callId)?.token ?? null);
  app.addHook('onClose', async () => {
    for (const s of streams) s.end();
    await Promise.allSettled(running);
  });
  return app;
}
