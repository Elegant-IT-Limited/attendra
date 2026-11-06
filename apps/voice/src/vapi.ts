// SPDX-License-Identifier: AGPL-3.0-only
import { type ActionRecorder, type Backend, CallAgent, CallCache, cachedBackend, CallState, type Planner } from '@attendra/agent';
import { ClinicConfig } from '@attendra/core';
import type { Logger } from '@attendra/observability';
import type { CallRecorder } from '@attendra/voice-engine';
import type { FastifyInstance } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Path C of the bake-off (batch 1a, round 2): a Vapi assistant (its transcriber, model and voice) whose function tools
 * are our tools API. Vapi posts every tool call and call event to one route, `POST /vapi/v1/events?clinic=<id>`, with
 * our shared secret; each Vapi call gets the same CallAgent, booking flow and safety rules as a call on our own engines,
 * recorded as engine `vapi`, flow `tools`. The conversation is kept from Vapi's own messages (conversation-update, and
 * the end-of-call report), so a read-back and the caller's yes are checked exactly as on our calls.
 * Not for a real clinic: the bake-off only (no clinic is switched to Vapi; batch 6 builds the full adapter).
 */
export interface VapiDeps {
  secret: string;
  clinicById(clinicId: string): Promise<unknown | null>;
  openCall(clinicId: string, sessionId: string, fromNumber: string | null, channel: 'phone' | 'web', startedBy?: string, calledAsLast4?: string, how?: { engine?: 'vapi'; voiceFlow?: 'tools' }): Promise<string>;
  recorderFor(clinicId: string, callId: string): CallRecorder;
  actionsFor(clinicId: string, callId: string): ActionRecorder;
  backend: Backend;
  planner: Planner;
  log: Logger;
  now: () => Date;
}

/** Vapi's message, as far as we read it. */
interface VapiMessage {
  type?: string;
  call?: { id?: string; type?: string; customer?: { number?: string } };
  toolCallList?: { id: string; function?: { name?: string; arguments?: unknown } }[];
  artifact?: { messages?: VapiLine[] };
  messages?: VapiLine[];
  endedReason?: string;
  durationSeconds?: number;
}
interface VapiLine { role?: string; message?: string; secondsFromStart?: number; duration?: number }

interface Session { agent: CallAgent; clinicId: string; callId: string; synced: number; startedAt: number; notes: string[] }

/** A Vapi call is forgotten after this long without a word from Vapi (its end-of-call report never came). */
const SESSION_TTL_MS = 2 * 3_600_000;

const digest = (s: string) => createHash('sha256').update(s).digest();

export function registerVapi(app: FastifyInstance, deps: VapiDeps) {
  const sessions = new Map<string, Session>();
  const expected = digest(deps.secret);
  const authorised = (headers: Record<string, unknown>) => {
    const raw = headers['x-vapi-secret'] ?? (typeof headers.authorization === 'string' && headers.authorization.startsWith('Bearer ') ? headers.authorization.slice(7) : undefined);
    return typeof raw === 'string' && timingSafeEqual(digest(raw), expected);
  };

  async function session(m: VapiMessage, clinicId: string): Promise<Session | null> {
    const vapiId = m.call?.id;
    if (!vapiId) return null;
    const known = sessions.get(vapiId);
    if (known) return known;
    const parsed = ClinicConfig.safeParse(await deps.clinicById(clinicId));
    if (!parsed.success) return null;
    const clinic = parsed.data;
    const web = m.call?.type === 'webCall';
    const from = web ? null : m.call?.customer?.number ?? null;
    const callId = await deps.openCall(clinic.id, `vapi_${vapiId}`, from, web ? 'web' : 'phone', undefined, undefined, { engine: 'vapi', voiceFlow: 'tools' });
    const cache = new CallCache();
    const backend = cachedBackend(deps.backend, cache);
    cache.warmSchedule(deps.backend.scheduler, clinic.id, clinic.providers.map((p) => p.id), deps.now());
    const agent = new CallAgent(new CallState(), { clinic, callId, callerNumber: from, now: deps.now, log: deps.log, channel: web ? 'web' : 'phone', history: null }, backend, deps.planner, deps.log, deps.actionsFor(clinic.id, callId));
    agent.state.answersAcrossPieces = true;
    const s: Session = { agent, clinicId: clinic.id, callId, synced: 0, startedAt: Date.now(), notes: [] };
    sessions.set(vapiId, s);
    deps.log.info({ call_id: callId, clinic_id: clinic.id, engine: 'vapi' }, 'vapi call opened');
    return s;
  }

  /** Vapi's conversation so far into the call state: the caller's lines through the guardrails, the assistant's as said. */
  function sync(s: Session, lines: VapiLine[] | undefined) {
    if (!lines) return;
    for (const l of lines.slice(s.synced)) {
      const text = (l.message ?? '').trim();
      const at = Math.round((l.secondsFromStart ?? 0) * 1000);
      const end = at + Math.round((l.duration ?? 0) * 1000 || 500);
      if (!text) continue;
      if (l.role === 'user') {
        // what the guardrails say on the caller's words (an emergency script, an abuse warning) goes with the next result
        for (const o of s.agent.onCallerTranscript(text, at, end)) if (o.type === 'instructions') s.notes.push(o.content);
      } else if (l.role === 'bot' || l.role === 'assistant') s.agent.onAgentTranscript(text, at, end);
    }
    s.synced = lines.length;
  }

  app.post('/vapi/v1/events', async (req, reply) => {
    if (!authorised(req.headers)) return reply.code(401).send({ error: 'unauthorized' });
    const clinicId = (req.query as { clinic?: string }).clinic;
    let m: VapiMessage;
    try { m = (JSON.parse(req.body as string) as { message?: VapiMessage }).message ?? {}; } catch { return reply.code(400).send({ error: 'invalid body' }); }
    if (!clinicId || !/^clinic_[A-Za-z0-9_]{1,60}$/.test(clinicId)) return reply.code(400).send({ error: 'clinic required' });
    for (const [id, s] of sessions) if (Date.now() - s.startedAt > SESSION_TTL_MS) sessions.delete(id);

    if (m.type === 'tool-calls') {
      const s = await session(m, clinicId);
      if (!s) return reply.code(200).send({ results: (m.toolCallList ?? []).map((t) => ({ toolCallId: t.id, error: 'This call cannot be helped here.' })) });
      sync(s, m.artifact?.messages);
      const results = [];
      for (const t of m.toolCallList ?? []) {
        const args = typeof t.function?.arguments === 'string' ? safeJson(t.function.arguments) : t.function?.arguments ?? {};
        const { output } = await s.agent.onToolCall(t.function?.name ?? '', args);
        // Vapi's voice hears the guardrails through the result: an emergency script first, as said on our own calls
        const notes = s.notes.splice(0);
        results.push({ toolCallId: t.id, result: JSON.stringify(notes.length ? { ...output, say: [notes.join(' '), output.say].filter(Boolean).join(' ') } : output) });
      }
      return reply.code(200).send({ results });
    }
    const s = m.call?.id ? sessions.get(m.call.id) : undefined;
    if (m.type === 'conversation-update' && s) sync(s, m.messages);
    if (m.type === 'end-of-call-report' && s) {
      sync(s, m.artifact?.messages);
      const recorder = deps.recorderFor(s.clinicId, s.callId);
      for (const t of s.agent.state.turns) await recorder.appendSegment({ speaker: t.speaker, text: t.text, startMs: t.startMs, endMs: t.endMs });
      await recorder.close({ reason: m.endedReason ?? 'ended', voiceSeconds: typeof m.durationSeconds === 'number' ? m.durationSeconds : null, outcome: s.agent.state.outcome, emergency: !!s.agent.state.emergency, language: s.agent.state.language, usage: { models: s.agent.state.modelTokens } });
      sessions.delete(m.call!.id!);
      deps.log.info({ call_id: s.callId, engine: 'vapi', reason: m.endedReason ?? 'ended' }, 'vapi call closed');
    }
    return reply.code(200).send({});
  });
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
