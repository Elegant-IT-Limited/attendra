// SPDX-License-Identifier: AGPL-3.0-only
import { type ActionRecorder, type Backend, CallAgent, CallState, type Planner } from '@attendra/agent';
import { ClinicConfig } from '@attendra/core';
import type { Logger } from '@attendra/observability';
import { callerNumber, dialledNumber } from '@attendra/telephony';
import { CallRunner, type CallRecorder, type VoiceEngine } from '@attendra/voice-engine';
import Fastify, { type FastifyInstance } from 'fastify';

export interface IncomingCall { id: string; type: string; data: { session_id: string; sip_headers?: { name: string; value: string }[] } }

export interface VoiceDeps {
  /** Verifies the OpenAI webhook signature and parses the event; throws when it is not genuine. */
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): Promise<IncomingCall>;
  claimDelivery(id: string): Promise<boolean>;
  clinicForNumber(e164: string): Promise<unknown | null>;
  openCall(clinicId: string, sessionId: string, fromNumber: string | null): Promise<string>;
  recorderFor(clinicId: string, callId: string): CallRecorder;
  actionsFor(clinicId: string, callId: string): ActionRecorder;
  engine: VoiceEngine;
  backend: Backend;
  planner: Planner;
  log: Logger;
  now?: () => Date;
}

const INCOMING = new Set(['live.transport.incoming', 'live.call.incoming']); // the second is deprecated but still delivered during migration

/**
 * The voice service's HTTP surface: one webhook and a health check. The webhook
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

  app.post('/webhooks/openai', async (req, reply) => {
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

    const task = handleIncoming(event);
    running.add(task);
    void task.finally(() => running.delete(task));
    return reply.code(200).send({ accepted: true });
  });

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
      const callId = await deps.openCall(clinic.id, sessionId, from);
      const agent = new CallAgent(new CallState(), { clinic, callId, callerNumber: from, now, log: deps.log }, deps.backend, deps.planner, deps.log, deps.actionsFor(clinic.id, callId));
      const runner = new CallRunner(sessionId, deps.engine, deps.engine.attach(sessionId), agent, deps.recorderFor(clinic.id, callId), deps.log);
      deps.log.info({ session_id: sessionId, clinic_id: clinic.id, call_id: callId }, 'call accepted');
      await runner.start();
    } catch (err) {
      deps.log.error({ session_id: sessionId, err }, 'call setup failed');
      // best effort: the call is already failing, and a second error must not escape
      await Promise.resolve().then(() => (accepted ? deps.engine.hangup(sessionId) : deps.engine.reject(sessionId, 503))).catch(() => {});
    }
  }

  app.addHook('onClose', async () => { await Promise.allSettled(running); });
  return app;
}
