// SPDX-License-Identifier: AGPL-3.0-only
import { type ActionRecorder, type Backend, CallAgent, CallState, type Planner } from '@attendra/agent';
import { ClinicConfig } from '@attendra/core';
import type { Logger } from '@attendra/observability';
import { callerNumber, dialledNumber } from '@attendra/telephony';
import { CallRunner, type CallRecorder, type VoiceEngine } from '@attendra/voice-engine';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export interface IncomingCall { id: string; type: string; data: { session_id: string; sip_headers?: { name: string; value: string }[] } }

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
  /** Shared with the API for browser test calls. Without it the internal route does not exist. */
  internalToken?: string;
  /** A browser test call is ended after this long. Defaults to 300. */
  browserCallMaxSeconds?: number;
  /** Browser test calls one clinic may have open at once. Defaults to 2. */
  browserCallsPerClinic?: number;
}

const WebCall = z.object({ clinicId: z.string().min(1).max(64), userId: z.string().min(1).max(64), sdp: z.string().min(1).max(64 * 1024) });
const WebCallEnd = z.object({ clinicId: z.string().min(1).max(64) });

/** Test calls never text anyone: the number a tester reads out may be a real patient's. */
const NO_TEXTS: Backend['messenger'] = { sendTemplate: async () => { throw new Error('texts are not sent on test calls'); } };

const digest = (s: string) => createHash('sha256').update(s).digest();

const INCOMING = new Set(['live.transport.incoming', 'live.call.incoming']); // the second is deprecated but still delivered during migration

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

  // keep the exact bytes: the signature is computed over the raw body
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  app.get('/healthz', async () => ({ ok: true }));

  // Every delivery costs a signature check and a database round trip, so the webhook
  // gets a per-address limit. OpenAI sends from a small pool of addresses, which is why
  // the default is generous. The health check stays unlimited for load balancers.
  app.register(async (webhooks) => {
    await webhooks.register(rateLimit, { max: deps.webhookRateLimit ?? 600, timeWindow: 60_000 });
    webhooks.post('/webhooks/openai', async (req, reply) => {
      let event: IncomingCall;
      try {
        event = await deps.verifyWebhook(req.body as string, req.headers);
      } catch {
        deps.log.warn({ path: '/webhooks/openai' }, 'rejected webhook with an invalid signature');
        return reply.code(400).send({ error: 'invalid signature' });
      }
      if (!INCOMING.has(event.type)) return reply.code(200).send({ ignored: event.type });
      // Claim the delivery (retries) and the session (the same call can arrive as both
      // live.transport.incoming and the deprecated live.call.incoming). First one wins.
      if (!(await deps.claimDelivery(event.id)) || !(await deps.claimDelivery(`session:${event.data.session_id}`))) {
        return reply.code(200).send({ duplicate: true });
      }

      track(handleIncoming(event));
      return reply.code(200).send({ accepted: true });
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
        track(runCall(clinic, sessionId, callId, null, 'web').finally(() => {
          webCalls.delete(callId);
          hold(clinic.id, -1);
        }));
        return reply.code(201).send({ callId, sdp: started.sdpAnswer, maxSeconds });
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
    });
  }

  function track(task: Promise<void>) {
    running.add(task);
    void task.finally(() => running.delete(task));
  }

  /** Runs an accepted conversation to the end, whichever way it came in. */
  async function runCall(clinic: ClinicConfig, sessionId: string, callId: string, from: string | null, channel: 'phone' | 'web') {
    const web = channel === 'web';
    const timers: NodeJS.Timeout[] = [];
    let closed = false;
    let hungUp = false;
    const hangup = () => { hungUp = true; return deps.engine.hangup(sessionId).catch(() => {}); };
    try {
      const backend = web ? { ...deps.backend, messenger: NO_TEXTS } : deps.backend;
      const agent = new CallAgent(new CallState(), { clinic, callId, callerNumber: from, now, log: deps.log }, backend, deps.planner, deps.log, deps.actionsFor(clinic.id, callId));
      const sideband = deps.engine.attach(sessionId);
      sideband.onEvent((e) => { if (e.type === 'session.closed') closed = true; });
      if (web) {
        timers.push(setTimeout(() => {
          deps.log.info({ session_id: sessionId }, 'test call reached its time limit');
          void hangup();
        }, maxSeconds * 1000));
        // if the session ignores the close, stop listening anyway so the call counts as over
        timers.push(setTimeout(() => sideband.close(), (maxSeconds + 30) * 1000));
      }
      const runner = new CallRunner(sessionId, deps.engine, sideband, agent, deps.recorderFor(clinic.id, callId), deps.log);
      deps.log.info({ session_id: sessionId, clinic_id: clinic.id, call_id: callId, channel }, 'call accepted');
      await runner.start();
    } catch (err) {
      deps.log.error({ session_id: sessionId, err }, 'call failed');
      await Promise.resolve().then(hangup);
    } finally {
      timers.forEach(clearTimeout);
      // A phone call ends with the line. A browser keeps talking after our sideband drops,
      // with no tools, recording or time limit, so end it explicitly.
      if (web && !closed && !hungUp) await hangup();
      if (web) deps.engine.release?.(sessionId);
    }
  }

  /**
   * Never leaves a caller in dead air: a failure before accepting rejects the call
   * with SIP 503 (the carrier plays its own message), a failure after accepting hangs up.
   */
  async function handleIncoming(event: IncomingCall) {
    const sessionId = event.data.session_id;
    const headers = event.data.sip_headers ?? [];
    let accepted = false;
    try {
      const dialled = dialledNumber(headers);
      const stored = dialled ? await deps.clinicForNumber(dialled) : null;
      if (!stored) {
        deps.log.warn({ session_id: sessionId }, 'no clinic for the dialled number; rejecting with 404');
        await deps.engine.reject(sessionId, 404);
        return;
      }
      const clinic = ClinicConfig.parse(stored);
      const from = callerNumber(headers);
      await deps.engine.accept(sessionId, clinic, now());
      accepted = true;
      const callId = await deps.openCall(clinic.id, sessionId, from, 'phone');
      await runCall(clinic, sessionId, callId, from, 'phone');
    } catch (err) {
      deps.log.error({ session_id: sessionId, err }, 'call setup failed');
      // best effort: the call is already failing, and a second error must not escape
      await Promise.resolve().then(() => (accepted ? deps.engine.hangup(sessionId) : deps.engine.reject(sessionId, 503))).catch(() => {});
    }
  }

  app.addHook('onClose', async () => { await Promise.allSettled(running); });
  return app;
}
