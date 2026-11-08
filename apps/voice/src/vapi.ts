// SPDX-License-Identifier: AGPL-3.0-only
import { type ActionRecorder, type Backend, CallAgent, CallCache, cachedBackend, CallState, type Outbound, type Planner } from '@attendra/agent';
import { ClinicConfig, isVapiTestClinic, maxGapMs, repeatedQuestions, vapiAlertAt } from '@attendra/core';
import type { Alerter, Logger } from '@attendra/observability';
import { type CallRecorder, VAPI_EVENTS_PATH, VAPI_SECRET_HEADER } from '@attendra/voice-engine';
import type { FastifyInstance } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';

export { VAPI_EVENTS_PATH } from '@attendra/voice-engine';

/**
 * Vapi as a location's backup voice engine (batch 6; path C of the bake-off before it). A location's Vapi assistant (its
 * transcriber, model and voice) has our tools API as its function tools: Vapi posts every tool call and call event to one
 * route, `POST /webhooks/vapi/v1/events?clinic=<id>` (under the webhooks path the proxy already sends to this service),
 * with the location's own secret. Each call gets the same CallAgent, booking flow and safety rules as a call on our own
 * engines, recorded as engine `vapi`, flow `tools`. The conversation is kept from Vapi's own messages (conversation-update,
 * and the end-of-call report), so a read-back and the caller's yes are checked exactly as on our calls. What our rules
 * decide during the call (an emergency script, a transfer, the end of the call) goes back through the call's control URL.
 *
 * A new call is taken only for a location on Vapi (`voiceEngine: 'vapi'`), or a test clinic; a call already going when
 * the location is switched back finishes as it is.
 */
export interface VapiOptions {
  /** VAPI_SERVER_SECRET: the deployment-wide secret, good for the test clinics only (core isVapiTestClinic). */
  testSecret?: string;
  /** Whether a presented secret is the location's own (vapi_secrets, migration 0056). */
  secretMatches(clinicId: string, presented: string): Promise<boolean>;
  /** The Vapi calls live at once across every location (vapi_live_calls), for the peak and the alert. */
  calls?: { live(vapiCallId: string, at: Date, alertAt: number): Promise<{ live: number; peak: number; alert: boolean }>; ended(vapiCallId: string, at: Date): Promise<void> };
  /** VAPI_MAX_CONCURRENCY: calls Vapi takes at once on this subscription (core VAPI_FREE_CONCURRENCY by default). */
  maxConcurrency: number;
  /** Posts to a call's control URL; the real fetch unless a test gives its own. */
  fetch?: typeof fetch;
  /** Runs `fn` after `ms` (a transfer after the line before it is said); tests and the scripted evals run it at once. */
  later?: (ms: number, fn: () => void) => void;
}

export interface VapiDeps extends VapiOptions {
  clinicById(clinicId: string): Promise<unknown | null>;
  openCall(clinicId: string, sessionId: string, fromNumber: string | null, channel: 'phone' | 'web', startedBy?: string, calledAsLast4?: string, how?: { engine?: 'vapi'; voiceFlow?: 'tools' }): Promise<string>;
  recorderFor(clinicId: string, callId: string): CallRecorder;
  actionsFor(clinicId: string, callId: string): ActionRecorder;
  backend: Backend;
  planner: Planner;
  log: Logger;
  alerts?: Alerter;
  now: () => Date;
}

/** Vapi's message, as far as we read it. */
interface VapiMessage {
  type?: string;
  status?: string;
  call?: { id?: string; type?: string; customer?: { number?: string }; monitor?: { controlUrl?: string } };
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
interface Session {
  agent: CallAgent; clinicId: string; callId: string; fed: { who: string; start: number; end: number }[]; startedAt: number; notes: string[];
  /** The call's control URL at Vapi (from its messages), where our transfers, hang-ups and scripts go. */
  controlUrl: string | null;
  /** Set once the call is over: a transfer or hang-up still waiting is dropped. */
  closed: boolean;
}

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

/** What the voice says of a rule's instruction: its quoted lines ("Say: \"...\""), or nothing when it quotes none (a note for the voice alone). */
export function quotedLines(instruction: string): string {
  return [...instruction.matchAll(/"([^"]+)"/g)].map((m) => m[1]!.trim()).join(' ');
}

/** A transfer target as Vapi's control URL takes it: a number (tel:) or a SIP address. */
export function vapiDestination(uri: string): { type: 'number'; number: string } | { type: 'sip'; sipUri: string } | null {
  const tel = /^tel:(\+[1-9]\d{6,14})$/.exec(uri);
  if (tel) return { type: 'number', number: tel[1]! };
  if (/^sips?:[^\s]+$/.test(uri)) return { type: 'sip', sipUri: uri };
  return null;
}

/** Only Vapi's own hosts get our control commands: a message is signed with our secret, and the address is checked too. */
const controlUrlOf = (m: VapiMessage): string | null => {
  const raw = m.call?.monitor?.controlUrl;
  if (typeof raw !== 'string') return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && (u.hostname === 'vapi.ai' || u.hostname.endsWith('.vapi.ai')) ? u.toString() : null;
  } catch { return null; }
};

/** A Vapi call is forgotten after this long without a word from Vapi (its end-of-call report never came). */
const SESSION_TTL_MS = 2 * 3_600_000;

const digest = (s: string) => createHash('sha256').update(s).digest();
const CLINIC_ID = /^clinic_[A-Za-z0-9_]{1,60}$/;

export function registerVapi(app: FastifyInstance, deps: VapiDeps) {
  const sessions = new Map<string, Session>();
  const refused = new Set<string>();
  const testSecret = deps.testSecret ? digest(deps.testSecret) : null;
  const post = deps.fetch ?? fetch;
  const later = deps.later ?? ((ms: number, fn: () => void) => { setTimeout(fn, ms).unref?.(); });
  const presentedOf = (headers: Record<string, unknown>) => {
    const raw = headers[VAPI_SECRET_HEADER] ?? (typeof headers.authorization === 'string' && headers.authorization.startsWith('Bearer ') ? headers.authorization.slice(7) : undefined);
    return typeof raw === 'string' && raw ? raw : null;
  };
  async function authorised(clinicId: string, presented: string | null): Promise<boolean> {
    if (!presented) return false;
    if (testSecret && isVapiTestClinic(clinicId) && timingSafeEqual(digest(presented), testSecret)) return true;
    return deps.secretMatches(clinicId, presented).catch((err: unknown) => {
      deps.log.error({ clinic_id: clinicId, err: { message: (err as Error).message } }, 'vapi: the location\'s secret could not be checked');
      return false;
    });
  }

  /** Sends one command to the call at Vapi; a failure is logged and said, never thrown into the call. */
  async function control(s: Session, body: Record<string, unknown>) {
    if (!s.controlUrl || s.closed) return;
    try {
      const res = await post(s.controlUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`control ${String(body.type)}: ${res.status}`);
    } catch (err) {
      deps.log.error({ call_id: s.callId, type: body.type, err: { message: (err as Error).message } }, 'vapi: a call control command failed');
      deps.alerts?.alert('vapi_control_failed', `A Vapi call could not be ${body.type === 'transfer' ? 'transferred' : body.type === 'end-call' ? 'ended' : 'told what to say'} (${(err as Error).message.slice(0, 80)}). Clinic ${s.clinicId}.`);
    }
  }

  /**
   * What our rules decided, on Vapi's call: a script the caller must hear (the emergency lines, word for word) is said at
   * once over whatever the model was saying, and the whole instruction goes into the conversation for the model; a
   * transfer or the end of the call follows the line before it, as on our engines (afterMs).
   */
  function act(s: Session, outs: Outbound[]) {
    for (const o of outs) {
      if (o.type === 'instructions') {
        // without a control URL (none in the message), it goes with the next tool result, as before
        if (!s.controlUrl) { s.notes.push(o.content); continue; }
        const lines = quotedLines(o.content);
        if (lines) void control(s, { type: 'say', content: lines, interruptAssistantEnabled: true });
        void control(s, { type: 'add-message', message: { role: 'system', content: o.content }, triggerResponseEnabled: false });
      } else if (o.type === 'transfer') {
        const destination = vapiDestination(o.uri);
        if (!destination) { deps.log.error({ call_id: s.callId }, 'vapi: a transfer to an address Vapi cannot dial'); continue; }
        later(o.afterMs ?? 0, () => void control(s, { type: 'transfer', destination }));
      } else if (o.type === 'hangup') {
        later(o.afterMs ?? 0, () => void control(s, { type: 'end-call' }));
      }
    }
  }

  /** The Vapi calls live at once: counted from the call's first message, with the alert at 70% of the limit, once a day. */
  async function live(vapiId: string) {
    if (!deps.calls) return;
    try {
      const limit = deps.maxConcurrency;
      const at = vapiAlertAt(limit);
      const { live: n, peak, alert } = await deps.calls.live(vapiId, deps.now(), at);
      if (alert) deps.alerts?.alert('vapi_concurrency', `Vapi calls at the same moment: ${n} of ${limit} (the alert is at ${at}); today's peak ${peak}. A call over the limit goes to our own engine (Twilio's fallback). Raise VAPI_MAX_CONCURRENCY with Vapi lines before it is reached.`);
    } catch (err) {
      deps.log.warn({ err: { message: (err as Error).message } }, 'vapi: a live call could not be counted');
    }
  }
  async function ended(vapiId: string) {
    await deps.calls?.ended(vapiId, deps.now()).catch((err: unknown) => deps.log.warn({ err: { message: (err as Error).message } }, 'vapi: a call end could not be counted'));
  }

  /** The call's session, opened on its first message; null when this location does not take Vapi calls now. */
  async function session(m: VapiMessage, clinicId: string): Promise<Session | null> {
    const vapiId = m.call?.id;
    if (!vapiId) return null;
    const known = sessions.get(vapiId);
    if (known) { known.controlUrl ??= controlUrlOf(m); return known; }
    // a call refused once stays refused, without a second alert for each of its messages
    if (refused.has(vapiId)) return null;
    const parsed = ClinicConfig.safeParse(await deps.clinicById(clinicId));
    if (!parsed.success) { refused.add(vapiId); return null; }
    const clinic = parsed.data;
    const test = isVapiTestClinic(clinic.id);
    // a new call only for a location on Vapi: one switched back sends its calls to our own engine again
    if (!test && clinic.voiceEngine !== 'vapi') {
      deps.log.warn({ clinic_id: clinic.id, engine: clinic.voiceEngine ?? 'default' }, 'vapi: a new call for a location not on Vapi; refused');
      deps.alerts?.alert('vapi_call_refused', `Vapi sent a new call for ${clinic.id}, which is not on Vapi: its number may still point at Vapi's trunk.`);
      refused.add(vapiId);
      return null;
    }
    const web = m.call?.type === 'webCall';
    const from = web ? null : m.call?.customer?.number ?? null;
    const callId = await deps.openCall(clinic.id, `vapi_${vapiId}`, from, web ? 'web' : 'phone', undefined, undefined, { engine: 'vapi', voiceFlow: 'tools' });
    const cache = new CallCache();
    // a test clinic's call texts nobody: what would have gone is recorded as not sent, as on a browser test call
    const base = test ? { ...deps.backend, messenger: { sendTemplate: (id: string, input: Parameters<Backend['messenger']['sendTemplate']>[1]) => deps.backend.messenger.sendTemplate(id, { ...input, testCall: true }) } } : deps.backend;
    const backend = cachedBackend(base, cache);
    cache.warmSchedule(deps.backend.scheduler, clinic.id, clinic.providers.map((p) => p.id), deps.now());
    const agent = new CallAgent(new CallState(), { clinic, callId, callerNumber: from, now: deps.now, log: deps.log, channel: web ? 'web' : 'phone', history: null }, backend, deps.planner, deps.log, deps.actionsFor(clinic.id, callId));
    agent.state.answersAcrossPieces = true;
    const s: Session = { agent, clinicId: clinic.id, callId, fed: [], startedAt: Date.now(), notes: [], controlUrl: controlUrlOf(m), closed: false };
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
        // what the guardrails decide on the caller's words (an emergency script, a transfer, an abusive caller's goodbye)
        act(s, s.agent.onCallerTranscript(text, at, end));
      } else if (l.role === 'bot' || l.role === 'assistant') {
        // a correction (a result said with no tool behind it) goes with the next result, as the guardrails' lines did
        for (const o of s.agent.onAgentTranscript(text, at, end)) if (o.type === 'instructions') s.notes.push(o.content);
      }
    }
  }

  app.post(VAPI_EVENTS_PATH, async (req, reply) => {
    // the secret first, before the body is read: a request without the location's secret learns nothing
    const clinicId = (req.query as { clinic?: string }).clinic;
    if (!clinicId || !CLINIC_ID.test(clinicId) || !(await authorised(clinicId, presentedOf(req.headers)))) return reply.code(401).send({ error: 'unauthorized' });
    let m: VapiMessage;
    try { m = (JSON.parse(req.body as string) as { message?: VapiMessage }).message ?? {}; } catch { return reply.code(400).send({ error: 'invalid body' }); }
    for (const [id, s] of sessions) if (Date.now() - s.startedAt > SESSION_TTL_MS) sessions.delete(id);
    if (refused.size > 10_000) refused.clear();
    const vapiId = m.call?.id;

    // the calls live at once, for Vapi's limit: from the call's status, or its first tool call if the status was missed
    if (vapiId && m.type === 'status-update' && m.status === 'in-progress') await live(vapiId);
    if (vapiId && ((m.type === 'status-update' && m.status === 'ended') || m.type === 'end-of-call-report')) await ended(vapiId);

    if (m.type === 'tool-calls') {
      if (vapiId && !sessions.has(vapiId)) await live(vapiId);
      const s = await session(m, clinicId);
      if (!s) return reply.code(200).send({ results: (m.toolCallList ?? []).map((t) => ({ toolCallId: t.id, error: 'This call cannot be helped here.' })) });
      sync(s, m.artifact?.messages);
      const results = [];
      for (const t of m.toolCallList ?? []) {
        const args = typeof t.function?.arguments === 'string' ? safeJson(t.function.arguments) : t.function?.arguments ?? {};
        const { output, controls } = await s.agent.onToolCall(t.function?.name ?? '', args);
        // a transfer or the end of the call that a tool decided happens after its line is said, as on our engines
        act(s, controls);
        // Vapi's voice hears what could not go through the control URL with the result: an emergency script first
        const notes = s.notes.splice(0);
        results.push({ toolCallId: t.id, result: JSON.stringify(notes.length ? { ...output, say: [notes.join(' '), output.say].filter(Boolean).join(' ') } : output) });
      }
      return reply.code(200).send({ results });
    }
    // the call is ours from its first message (its status, or the conversation): our guardrails hear the caller's words
    // even when the model calls no tool (an emergency in the first sentence), and the call is on file from its start
    const opens = m.type === 'conversation-update' || m.type === 'end-of-call-report' || (m.type === 'status-update' && m.status === 'in-progress');
    const s = vapiId ? sessions.get(vapiId) ?? (opens ? await session(m, clinicId) ?? undefined : undefined) : undefined;
    if (s) s.controlUrl ??= controlUrlOf(m);
    if (m.type === 'conversation-update' && s) sync(s, m.messages);
    if (m.type === 'end-of-call-report' && s) {
      const lines = m.artifact?.messages ?? [];
      sync(s, lines);
      s.closed = true;
      // the waits for an answer that needed our tools, and the first audio, from Vapi's own times: as exact as our engines'
      for (const w of vapiAnswerWaits(lines)) s.agent.recordAnswerTiming({ ...w, flow: 'tools' });
      const recorder = deps.recorderFor(s.clinicId, s.callId);
      // the record from Vapi's final transcript, each line once (what the agent was fed came in windows, line by line);
      // without one, what the agent was fed
      const record = lines.some(spoken) ? vapiRecordLines(lines) : s.agent.state.turns.map((t) => ({ speaker: t.speaker, text: t.text, startMs: t.startMs, endMs: t.endMs }));
      for (const line of record) await recorder.appendSegment(line);
      await recorder.close({ reason: m.endedReason ?? 'ended', voiceSeconds: typeof m.durationSeconds === 'number' ? m.durationSeconds : null, outcome: s.agent.state.outcome, emergency: !!s.agent.state.emergency, emergencyResult: s.agent.state.emergencyResult, language: s.agent.state.language, quality: { firstAudioMs: vapiFirstAudioMs(lines), stalls: 0, answerTimeouts: 0, maxGapMs: maxGapMs(record), repeatedQuestions: repeatedQuestions(record).length }, usage: { models: s.agent.state.modelTokens, ...(typeof m.cost === 'number' && m.cost >= 0 ? { engineUsd: m.cost } : {}) } });
      sessions.delete(vapiId!);
      deps.log.info({ call_id: s.callId, engine: 'vapi', reason: m.endedReason ?? 'ended' }, 'vapi call closed');
    }
    return reply.code(200).send({});
  });
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
