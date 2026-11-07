// SPDX-License-Identifier: AGPL-3.0-only
import { type ActionRecorder, type Backend, CallAgent, CallCache, cachedBackend, CallState, type Planner } from '@attendra/agent';
import { ClinicConfig } from '@attendra/core';
import type { Logger } from '@attendra/observability';
import type { CallRecorder } from '@attendra/voice-engine';
import type { FastifyInstance } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Path C of the bake-off (batch 1a, round 2): a Vapi assistant (its transcriber, model and voice) whose function tools
 * are our tools API. Vapi posts every tool call and call event to one route, `POST /webhooks/vapi/v1/events?clinic=<id>` (under the
 * webhooks path the proxy already sends to this service), with
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
  /** What Vapi charged for the call, all parts, in dollars. */
  cost?: number;
}
/** A line of Vapi's conversation: `secondsFromStart` in seconds, `duration` in milliseconds (as Vapi sends them). */
interface VapiLine { role?: string; message?: string; secondsFromStart?: number; duration?: number }

/**
 * One Vapi call. `fed`: the lines already given to the agent, by speaker and time span. Vapi sends its conversation as a
 * window of the latest lines, in two shapes (a tool call's artifact, and conversation-update), and sends a line again
 * with slightly different times or as a shorter piece of itself; counting places in the list fed some lines three times
 * (the bake-off record, 2026-11-07: three times the lines said, 117 "repeated questions" no caller heard). A line that
 * overlaps one already fed from the same speaker is that line again.
 */
interface Session { agent: CallAgent; clinicId: string; callId: string; fed: { who: string; start: number; end: number }[]; startedAt: number; notes: string[] }

/** Vapi's own times, in ms from the call's start: when a line began and ended. */
const startOf = (l: VapiLine) => Math.round((l.secondsFromStart ?? 0) * 1000);
const endOf = (l: VapiLine) => startOf(l) + (Math.round(l.duration ?? 0) || 500);
const spoken = (l: VapiLine) => (l.role === 'user' || l.role === 'bot' || l.role === 'assistant') && !!(l.message ?? '').trim();
const whoOf = (l: VapiLine) => (l.role === 'user' ? 'caller' : 'agent') as 'caller' | 'agent';
const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;

/**
 * The call's lines for the record, from Vapi's final transcript (the end-of-call report holds the whole call): in time
 * order, and where two lines of one speaker overlap (a piece of a line and the whole line), the fuller one.
 */
export function vapiRecordLines(lines: VapiLine[]): { speaker: 'caller' | 'agent'; text: string; startMs: number; endMs: number }[] {
  const out: { speaker: 'caller' | 'agent'; text: string; startMs: number; endMs: number }[] = [];
  for (const l of [...lines].filter(spoken).sort((a, b) => startOf(a) - startOf(b))) {
    const line = { speaker: whoOf(l), text: (l.message ?? '').trim(), startMs: startOf(l), endMs: endOf(l) };
    const same = out.findLast((o) => o.speaker === line.speaker && overlaps({ start: o.startMs, end: o.endMs }, { start: line.startMs, end: line.endMs }));
    if (!same) { out.push(line); continue; }
    if (line.text.length > same.text.length) Object.assign(same, line);
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/**
 * How long each caller waited for an answer that needed our tools, from Vapi's conversation: the caller's last line
 * before a tool call ends, the assistant's next line starts. Tool calls in a row before one answer count as one wait.
 */
export function vapiAnswerWaits(lines: VapiLine[]): { waitMs: number; tools: number }[] {
  const out: { waitMs: number; tools: number }[] = [];
  let lastCallerEnd: number | null = null;
  let tools = 0;
  for (const l of lines) {
    if (l.role === 'user' && spoken(l)) { lastCallerEnd = endOf(l); tools = 0; continue; }
    if (l.role === 'tool_calls') { tools++; continue; }
    if ((l.role === 'bot' || l.role === 'assistant') && spoken(l)) {
      if (tools && lastCallerEnd !== null) out.push({ waitMs: Math.max(0, startOf(l) - lastCallerEnd), tools });
      tools = 0; lastCallerEnd = null;
    }
  }
  return out;
}

/** When the caller first heard the assistant: its first line's start, from the call's answer. */
export const vapiFirstAudioMs = (lines: VapiLine[]): number | null => {
  const first = lines.find((l) => (l.role === 'bot' || l.role === 'assistant') && spoken(l));
  return first ? startOf(first) : null;
};

/** Where Vapi posts: under /webhooks, which the proxy in front of the voice service already routes to it. */
export const VAPI_EVENTS_PATH = '/webhooks/vapi/v1/events';

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
    // a bake-off call texts nobody: what would have gone is recorded as not sent, as on a browser test call
    const quiet = { ...deps.backend, messenger: { sendTemplate: (id: string, input: Parameters<Backend['messenger']['sendTemplate']>[1]) => deps.backend.messenger.sendTemplate(id, { ...input, testCall: true }) } };
    const backend = cachedBackend(quiet, cache);
    cache.warmSchedule(deps.backend.scheduler, clinic.id, clinic.providers.map((p) => p.id), deps.now());
    const agent = new CallAgent(new CallState(), { clinic, callId, callerNumber: from, now: deps.now, log: deps.log, channel: web ? 'web' : 'phone', history: null }, backend, deps.planner, deps.log, deps.actionsFor(clinic.id, callId));
    agent.state.answersAcrossPieces = true;
    const s: Session = { agent, clinicId: clinic.id, callId, fed: [], startedAt: Date.now(), notes: [] };
    sessions.set(vapiId, s);
    deps.log.info({ call_id: callId, clinic_id: clinic.id, engine: 'vapi' }, 'vapi call opened');
    return s;
  }

  /** Vapi's conversation so far into the call state: the caller's lines through the guardrails, the assistant's as said. */
  function sync(s: Session, lines: VapiLine[] | undefined) {
    if (!lines) return;
    for (const l of lines) {
      if (!spoken(l)) continue;
      const span = { who: whoOf(l), start: startOf(l), end: endOf(l) };
      if (s.fed.some((f) => f.who === span.who && overlaps(f, span))) continue;
      s.fed.push(span);
      const text = (l.message ?? '').trim();
      // duration is already in ms: read as seconds, every line ended ~1000x too late, so a caller's yes always fell
      // before the read-back's end and the number was never confirmed (bake-off call, 2026-11-07: verify_caller looped)
      const at = startOf(l);
      const end = endOf(l);
      if (l.role === 'user') {
        // what the guardrails say on the caller's words (an emergency script, an abuse warning) goes with the next result
        for (const o of s.agent.onCallerTranscript(text, at, end)) if (o.type === 'instructions') s.notes.push(o.content);
      } else if (l.role === 'bot' || l.role === 'assistant') s.agent.onAgentTranscript(text, at, end);
    }
  }

  app.post(VAPI_EVENTS_PATH, async (req, reply) => {
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
      const lines = m.artifact?.messages ?? [];
      sync(s, lines);
      // the waits for an answer that needed our tools, and the first audio, from Vapi's own times: as exact as our engines'
      for (const w of vapiAnswerWaits(lines)) s.agent.recordAnswerTiming({ ...w, flow: 'tools' });
      const recorder = deps.recorderFor(s.clinicId, s.callId);
      // the record from Vapi's final transcript, each line once (what the agent was fed came in windows, line by line);
      // without one, what the agent was fed
      const record = lines.some(spoken) ? vapiRecordLines(lines) : s.agent.state.turns.map((t) => ({ speaker: t.speaker, text: t.text, startMs: t.startMs, endMs: t.endMs }));
      for (const line of record) await recorder.appendSegment(line);
      await recorder.close({ reason: m.endedReason ?? 'ended', voiceSeconds: typeof m.durationSeconds === 'number' ? m.durationSeconds : null, outcome: s.agent.state.outcome, emergency: !!s.agent.state.emergency, emergencyResult: s.agent.state.emergencyResult, language: s.agent.state.language, quality: { firstAudioMs: vapiFirstAudioMs(lines), stalls: 0, answerTimeouts: 0 }, usage: { models: s.agent.state.modelTokens, ...(typeof m.cost === 'number' && m.cost >= 0 ? { engineUsd: m.cost } : {}) } });
      sessions.delete(m.call!.id!);
      deps.log.info({ call_id: s.callId, engine: 'vapi', reason: m.endedReason ?? 'ended' }, 'vapi call closed');
    }
    return reply.code(200).send({});
  });
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
