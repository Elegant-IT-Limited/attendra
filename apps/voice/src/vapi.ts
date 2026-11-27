// SPDX-License-Identifier: AGPL-3.0-only
import { type ActionRecorder, type Backend, CallAgent, CallCache, cachedBackend, CallState, type Outbound, type Planner } from '@attendra/agent';
import { digitsAsWords, callFacts, type CallEventSink, ClinicConfig, DEMO_BUSY_LINE, DEMO_GOODBYE_LINE, DEMO_LIMITS, DEMO_WRAP_UP_LINE, type DemoLimitCode, forVapiVoice, fromVapiVoice, isDemoClinic, type Language, lastFour, spokenDigits, isVapiTestClinic, longestWaitMs, repeatedQuestions, vapiAlertAt } from '@attendra/core';
import { type Alerter, isVapiCreditEnd, isVapiOpenAiQuotaEnd, type Logger } from '@attendra/observability';
import { type CallRecorder, callFactsNote, LOOKUPS_AHEAD_MAX, VAPI_EVENTS_PATH, VAPI_SECRET_HEADER } from '@attendra/voice-engine';
import type { FastifyInstance } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { LiveRegistry } from './live';

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
  /** The call's event log (foundation A): Vapi's message types, and at the end its line times. Without it nothing is logged. */
  callEventsFor?(clinicId: string, callId: string, path: string): CallEventSink;
  backend: Backend;
  planner: Planner;
  log: Logger;
  alerts?: Alerter;
  now: () => Date;
  /** A demo clinic's limits (core demo-clinic.ts), checked when its phone call opens; the voice service's own check. */
  demoLimitFor?(clinic: ClinicConfig, from: string | null): Promise<DemoLimitCode | null>;
  /**
   * The calls staff watch live (live.ts), the same registry path A's calls are in: a Vapi call is on the dashboard's
   * live strip from its first message, with its captions, tool steps and state, and "Take the call", a staff note and
   * "End" act on it through its control URL (V1, 2026-11-18: a Vapi call showed nothing until it ended).
   */
  live?: LiveRegistry;
}

/** A demo call turned away on Vapi is ended this long after it opened, whatever Vapi's assistant does. */
const DEMO_LIMIT_MAX_MS = 10_000;

/** Vapi's message, as far as we read it. */
interface VapiMessage {
  type?: string;
  status?: string;
  call?: { id?: string; type?: string; customer?: { number?: string }; monitor?: { controlUrl?: string } };
  /** The caller, as Vapi also sends it beside the call on its server messages. */
  customer?: { number?: string };
  toolCallList?: { id: string; function?: { name?: string; arguments?: unknown } }[];
  artifact?: { messages?: VapiLine[] };
  messages?: VapiLine[];
  endedReason?: string;
  durationSeconds?: number;
  /** What Vapi charged for the call, all parts, in dollars. */
  cost?: number;
  /** A transcript message: whose words, partial or final, and the words. */
  role?: string;
  transcriptType?: string;
  transcript?: string;
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
  /**
   * This call's own facts (core callFacts: the clinic's date and time, open or closed, the caller ID and the number
   * question; in path A's words, callFactsNote), until they are sent into the call: the assistant's prompt is the same
   * on every call of the location.
   */
  facts: string | null;
  /** A demo call turned away by a limit: its tool calls are refused, and it is ended. */
  refused: boolean;
  /** Commands waiting for the call's control URL (none in the first message): sent as soon as it is known. */
  pending: Record<string, unknown>[];
  /** Vapi said the call ended (its status): no longer live for a restart's drain, though its report may still come. */
  over?: boolean;
  /** The call's event log: each message's type, never its content. */
  events: CallEventSink;
  /** The caller ID's last four digits (ours, from the call), or null without one: the only digits said for it (V2). */
  callerLast4: string | null;
  /** Wrong caller-ID digits the assistant said and was corrected for, so each is corrected once. */
  corrected: Set<string>;
  /**
   * The caller's words given to the agent from Vapi's final transcripts, before Vapi's own line for them (lookup-ahead):
   * that line, when it comes, is fed only for any words it adds. Normalised words, cleared once the line is matched.
   */
  early: string;
}

const NO_EVENTS: CallEventSink = { add: () => {}, close: async () => ({ written: 0, dropped: 0 }) };

/**
 * A Vapi call's turns for its event log, from the end-of-call report's lines (Vapi's own times, as vapiAnswerWaits reads
 * them): when the caller started and stopped, and when the assistant started and stopped, and each tool call's moment.
 * Times and kinds only. The daily numbers read stalls and reply times from them, as from the Realtime events.
 */
export function vapiTurnEvents(lines: VapiLine[]): { type: string; atMs: number }[] {
  const out: { type: string; atMs: number }[] = [];
  for (const l of vapiRecordLines(lines)) {
    const who = l.speaker === 'caller' ? 'caller' : 'assistant';
    out.push({ type: `vapi.${who}.started`, atMs: l.startMs }, { type: `vapi.${who}.stopped`, atMs: l.endMs });
  }
  for (const l of lines) if (l.role === 'tool_calls') out.push({ type: 'vapi.tool_calls', atMs: startOf(l) });
  return out.sort((a, b) => a.atMs - b.atMs);
}

/** Vapi's own times, in ms from the call's start: when a line began and ended. */
const startOf = (l: VapiLine) => Math.round((l.secondsFromStart ?? 0) * 1000);
const endOf = (l: VapiLine) => startOf(l) + (Math.round(l.duration ?? 0) || 500);
const spoken = (l: VapiLine) => (l.role === 'user' || l.role === 'bot' || l.role === 'assistant') && !!(l.message ?? '').trim();
const whoOf = (l: VapiLine) => (l.role === 'user' ? 'caller' : 'agent') as 'caller' | 'agent';
const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;
/** Words for comparing a line with transcripts: lower case, letters and digits only, single spaces. */
const normalWords = (text: string) => text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/**
 * Vapi's line for the caller, against the words already given from its final transcripts (`early`): what of the line is
 * still to be fed ('' for nothing, null for the whole line: not those words), and what of `early` is left for the next
 * line (the caller spoke twice before Vapi's lines came: "Yes." then "For Rocky.").
 */
export function afterEarly(line: string, early: string): { rest: string | null; early: string } {
  const said = normalWords(line);
  if (!said || said === early) return { rest: '', early: '' };
  if (early.startsWith(`${said} `)) return { rest: '', early: early.slice(said.length + 1) };
  if (!said.startsWith(`${early} `)) return { rest: null, early: '' };
  // the rest in the line's own words: its words from where the early words end
  const want = early.split(' ').length;
  const words = line.trim().split(/\s+/);
  let n = 0;
  let i = 0;
  while (i < words.length && n < want) { n += normalWords(words[i]!).split(' ').filter(Boolean).length; i++; }
  return { rest: words.slice(i).join(' '), early: '' };
}

/**
 * The call's lines for the record, from Vapi's final transcript (the end-of-call report holds the whole call): in time
 * order, and where two lines of one speaker overlap (a piece of a line and the whole line), the fuller one.
 */
export function vapiRecordLines(lines: VapiLine[]): { speaker: 'caller' | 'agent'; text: string; startMs: number; endMs: number }[] {
  const out: { speaker: 'caller' | 'agent'; text: string; startMs: number; endMs: number }[] = [];
  for (const l of [...lines].filter(spoken).sort((a, b) => startOf(a) - startOf(b))) {
    const text = (l.message ?? '').trim();
    const line = { speaker: whoOf(l), text: whoOf(l) === 'agent' ? fromVapiVoice(text) : text, startMs: startOf(l), endMs: endOf(l) };
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

/**
 * The caller-ID digits the assistant said, when it said ones that are not the caller ID's (V2, 2026-11-17: "the number
 * you're calling from, ending 0 0 9 2" on a call from a number ending 0090); null when it said none, or the right ones.
 * Only a mention of the number they are calling from counts, in English or Spanish, in digits or in words.
 */
export function wrongCallerIdDigits(line: string, last4: string | null): string | null {
  if (!last4) return null;
  const m = /(?:calling (?:us )?from|call(?:ing)? from|desde el que (?:nos )?llama)\W+(?:[^.?!]{0,30}?\b)?(?:ending(?: in| with)?|ends (?:in|with)|que termina en|termina en)\s+([^.?!]{1,40})/i.exec(line);
  if (!m) return null;
  const said = spokenDigits(m[1]!).replace(/\D/g, '').slice(0, 4);
  return said.length === 4 && said !== last4 ? said : null;
}

/** The assistant's correction of the caller ID's digits: ours, one by one. */
export const callerIdCorrection = (lang: Language, last4: string) => {
  // as words, one by one: Vapi's voice read "0 0 9 0" as "visual 0 9 0" (R11)
  const digits = digitsAsWords(last4, lang === 'es' ? 'es' : 'en');
  return lang === 'es' ? `Perdón, me equivoqué: el número desde el que llama termina en ${digits}.` : `Sorry, I misspoke: the number you're calling from ends in ${digits}.`;
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

/**
 * The control address Vapi gives in a call's messages, or null. Only Vapi's own hosts get our control commands: the
 * message is already authenticated by the location's secret, and the address must also be a plain https URL on vapi.ai
 * or a subdomain of it (an exact suffix match, so evilvapi.ai or vapi.ai.example.com fail), with no user name or
 * password and the default port. The host itself is not pinned: Vapi's docs say it can change between calls.
 */
export function vapiControlUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.port !== '') return null;
  const host = u.hostname.toLowerCase();
  if (host !== 'vapi.ai' && !host.endsWith('.vapi.ai')) return null;
  return u.toString();
}
const controlUrlOf = (m: VapiMessage): string | null => vapiControlUrl(m.call?.monitor?.controlUrl);

/** A Vapi call is forgotten after this long without a word from Vapi (its end-of-call report never came). */
const SESSION_TTL_MS = 2 * 3_600_000;

const digest = (s: string) => createHash('sha256').update(s).digest();
const CLINIC_ID = /^clinic_[A-Za-z0-9_]{1,60}$/;

/**
 * The route, and the Vapi calls live now for a restart's drain (drain.ts). A new Vapi call during a drain is still
 * served: Vapi has already answered it, and refusing our tools would leave the caller with an assistant that cannot
 * look anything up. A call cut by the restart carries on at Vapi; its next message opens a new session here.
 */
export function registerVapi(app: FastifyInstance, deps: VapiDeps): { liveCalls(): number } {
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

  /** A command's words as Vapi's voice should say them (forVapiVoice): a line to say, or a message for its model. */
  const spokenForVapi = (c: Record<string, unknown>): Record<string, unknown> => {
    if (typeof c.content === 'string') return { ...c, content: forVapiVoice(c.content) };
    const m = c.message as { role?: string; content?: unknown } | undefined;
    return m && typeof m.content === 'string' ? { ...c, message: { ...m, content: forVapiVoice(m.content) } } : c;
  };

  /** Sends one command to the call at Vapi; a failure is logged and said, never thrown into the call. Whether it went. */
  async function control(s: Session, command: Record<string, unknown>): Promise<boolean> {
    if (!s.controlUrl || s.closed) return false;
    const body = spokenForVapi(command);
    try {
      // never follows a redirect (a redirect is a failure, like any answer that is not 2xx), and gives up after 5 s
      const res = await post(s.controlUrl, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      if (!res.ok || res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) throw new Error(`control ${String(body.type)}: ${res.status}`);
      return true;
    } catch (err) {
      deps.log.error({ call_id: s.callId, type: body.type, err: { message: (err as Error).message } }, 'vapi: a call control command failed');
      deps.alerts?.alert('vapi_control_failed', `A Vapi call could not be ${body.type === 'transfer' ? 'transferred' : body.type === 'end-call' ? 'ended' : 'told what to say'} (${(err as Error).message.slice(0, 80)}).`, { clinicId: s.clinicId, callId: s.callId });
      return false;
    }
  }

  /**
   * What our rules decided, on Vapi's call: a script the caller must hear (the emergency lines, word for word) is said at
   * once over whatever the model was saying, and the whole instruction goes into the conversation for the model; a
   * transfer or the end of the call follows the line before it, as on our engines (afterMs). `staff`: a staff member's
   * take-over or end (the live page): one that does not go through gives the call back to staff and the assistant offers
   * a callback, as on path A (CallAgent.onControlFailed).
   */
  function act(s: Session, outs: Outbound[], staff = false) {
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
        later(o.afterMs ?? 0, () => void control(s, { type: 'transfer', destination }).then((ok) => { if (staff && !ok && !s.closed) act(s, s.agent.onControlFailed('transfer')); }));
      } else if (o.type === 'hangup') {
        later(o.afterMs ?? 0, () => void control(s, { type: 'end-call' }).then((ok) => { if (staff && !ok && !s.closed) act(s, s.agent.onControlFailed('hangup')); }));
      }
    }
  }

  /**
   * The call on the live strip (live.ts), as path A opens it (server.ts): every agent event is published (captions from
   * Vapi's conversation, tool steps, state, the emergency), and staff act on the call through its control URL. A staff
   * note goes to the model as a system message only: its words are quoted, and act() says quoted lines aloud.
   */
  function openLive(s: Session, clinic: ClinicConfig, web: boolean) {
    const live = deps.live;
    if (!live) return;
    const { agent, callId } = s;
    const frontDesk = clinic.routing.find((r) => r.target === 'front_desk')?.uri ?? null;
    live.open(callId, { clinicId: s.clinicId, channel: web ? 'web' : 'phone', startedAt: deps.now(), frontDesk }, {
      coach: async (note, by) => {
        const [first, ...rest] = agent.coach(note, by);
        const content = first?.type === 'instructions' ? first.content : '';
        if (!(await control(s, { type: 'add-message', message: { role: 'system', content }, triggerResponseEnabled: false }))) throw new Error('the staff note did not reach the Vapi call');
        agent.onCoachDelivered();
        // the emergency script, sent again after a note (CallAgent.coach), is said as any rule's script
        act(s, rest);
      },
      takeOver: async (uri, by) => { act(s, agent.takeOver(uri, by), true); },
      end: async (by) => { act(s, agent.endByStaff(by), true); },
      canEnd: () => agent.canEndByStaff(),
    });
    agent.observer = (e) => live.publish(callId, e);
  }

  /** A command that must reach the call even when its control URL is not known yet: kept until it is. */
  function controlSoon(s: Session, body: Record<string, unknown>) {
    if (s.controlUrl) void control(s, body);
    else s.pending.push(body);
  }
  function flushPending(s: Session) {
    if (!s.controlUrl || !s.pending.length) return;
    for (const body of s.pending.splice(0)) void control(s, body);
  }

  /**
   * The call's own facts into the conversation, once, as soon as there is a control URL: a system message that starts
   * no reply. Without one (none in the messages yet), they go with the first tool result instead (tool-calls below).
   */
  function sendFacts(s: Session) {
    if (!s.facts || !s.controlUrl || s.closed) return;
    const content = s.facts;
    s.facts = null;
    void control(s, { type: 'add-message', message: { role: 'system', content }, triggerResponseEnabled: false });
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
    if (known) { known.controlUrl ??= controlUrlOf(m); sendFacts(known); flushPending(known); return known; }
    // a call refused once stays refused, without a second alert for each of its messages
    if (refused.has(vapiId)) return null;
    const parsed = ClinicConfig.safeParse(await deps.clinicById(clinicId));
    if (!parsed.success) { refused.add(vapiId); return null; }
    const clinic = parsed.data;
    const test = isVapiTestClinic(clinic.id);
    // a new call only for a location on Vapi: one switched back sends its calls to our own engine again
    if (!test && clinic.voiceEngine !== 'vapi') {
      deps.log.warn({ clinic_id: clinic.id, engine: clinic.voiceEngine ?? 'default' }, 'vapi: a new call for a location not on Vapi; refused');
      deps.alerts?.alert('vapi_call_refused', `Vapi sent a new call for a location that is not on Vapi: its number may still point at Vapi's trunk.`, { clinicId: clinic.id, clinicName: clinic.name });
      refused.add(vapiId);
      return null;
    }
    const web = m.call?.type === 'webCall';
    const from = web ? null : m.call?.customer?.number ?? m.customer?.number ?? null;
    // a demo clinic's limits, as on our own engines: checked once, when its phone call opens
    const demo = !web && isDemoClinic(clinic);
    const demoLimit = demo && deps.demoLimitFor ? await deps.demoLimitFor(clinic, from) : null;
    const callId = await deps.openCall(clinic.id, `vapi_${vapiId}`, from, web ? 'web' : 'phone', undefined, undefined, { engine: 'vapi', voiceFlow: 'tools' });
    const cache = new CallCache();
    // a test clinic's call texts nobody: what would have gone is recorded as not sent, as on a browser test call
    const base = test ? { ...deps.backend, messenger: { sendTemplate: (id: string, input: Parameters<Backend['messenger']['sendTemplate']>[1]) => deps.backend.messenger.sendTemplate(id, { ...input, testCall: true }) } } : deps.backend;
    const backend = cachedBackend(base, cache);
    cache.warmSchedule(deps.backend.scheduler, clinic.id, clinic.providers.map((p) => p.id), deps.now());
    const agent = new CallAgent(new CallState(), { clinic, callId, callerNumber: from, now: deps.now, log: deps.log, channel: web ? 'web' : 'phone', history: null }, backend, deps.planner, deps.log, deps.actionsFor(clinic.id, callId));
    agent.state.answersAcrossPieces = true;
    // the caller ID reaches every tool as on path A (the agent's callerNumber), and the voice hears it with the date
    const s: Session = { agent, clinicId: clinic.id, callId, fed: [], startedAt: Date.now(), notes: [], controlUrl: controlUrlOf(m), closed: false,
      facts: demoLimit ? null : callFactsNote(clinic, callFacts(clinic, deps.now(), from)), refused: !!demoLimit, pending: [], events: deps.callEventsFor?.(clinic.id, callId, 'vapi/tools') ?? NO_EVENTS,
      callerLast4: from ? lastFour(from) : null, corrected: new Set(), early: '' };
    sessions.set(vapiId, s);
    openLive(s, clinic, web);
    // the household on the caller ID, read while the greeting plays: the first identity lookup answers from memory
    if (!demoLimit) void agent.preloadHousehold();
    if (demoLimit) {
      // over a limit: the one fixed line over whatever Vapi's assistant began, then the end; recorded with the limit's code
      agent.demoLimited(demoLimit);
      controlSoon(s, { type: 'say', content: DEMO_BUSY_LINE[clinic.primaryLanguage], interruptAssistantEnabled: true, endCallAfterSpoken: true });
      later(DEMO_LIMIT_MAX_MS, () => controlSoon(s, { type: 'end-call' }));
      deps.log.info({ call_id: callId, clinic_id: clinic.id, engine: 'vapi', code: demoLimit }, 'demo clinic: the call is over a limit and hears the busy line');
      return s;
    }
    if (demo) {
      // a demo call: a polite line at 14:00, the goodbye and the end at 15:00 (Vapi says them word for word)
      const lang = clinic.primaryLanguage;
      later(DEMO_LIMITS.wrapUpAtSeconds * 1000, () => controlSoon(s, { type: 'say', content: DEMO_WRAP_UP_LINE[lang] }));
      later(DEMO_LIMITS.callSeconds * 1000, () => controlSoon(s, { type: 'say', content: DEMO_GOODBYE_LINE[lang], interruptAssistantEnabled: true, endCallAfterSpoken: true }));
      later(DEMO_LIMITS.callSeconds * 1000 + 15_000, () => controlSoon(s, { type: 'end-call' }));
    }
    sendFacts(s);
    deps.log.info({ call_id: callId, clinic_id: clinic.id, engine: 'vapi' }, 'vapi call opened');
    return s;
  }

  /**
   * The caller ID's last four digits, ours, with an identity tool's answer that does not end the check (a refusal, a
   * question, the household's pets), so the model never says them from memory (V2: it said "ending 0 0 9 2" for 0090,
   * the facts message far back in the call). A found pet needs none; a call without caller ID has none.
   */
  function withCallerId(s: Session, tool: string, output: { ok: boolean; say?: string; data: Record<string, unknown> }) {
    if (!s.callerLast4 || (tool !== 'verify_caller' && tool !== 'register_patient')) return;
    if (output.data.verified === true || output.data.registered === true) return;
    output.data.caller_id_last4 = s.callerLast4;
    const words = digitsAsWords(s.callerLast4, s.agent.state.language === 'es' ? 'es' : 'en');
    const note = `The number they are calling from (caller ID) ends in ${words}: if you mention it, say exactly these four digits, as these words, never others.`;
    output.say = [output.say, note].filter(Boolean).join(' ');
  }

  /**
   * The caller ID's digits are ours, never the model's (V2): when the assistant says the number they are calling from
   * ends in other digits, the right ones are said at once, and the model is told, once per wrong number.
   */
  function correctCallerId(s: Session, line: string) {
    const wrong = wrongCallerIdDigits(line, s.callerLast4);
    if (!wrong || !s.callerLast4 || s.corrected.has(wrong)) return;
    s.corrected.add(wrong);
    deps.log.warn({ call_id: s.callId }, 'vapi: the assistant said other digits for the caller ID; corrected');
    const said = callerIdCorrection(s.agent.state.language, s.callerLast4);
    act(s, [{ type: 'instructions', delegationId: null, content: `You said the wrong digits for the number they are calling from. Say: "${said}" Then carry on. Its last four digits are ${s.callerLast4}: say only these, never others.` }]);
  }

  /** Vapi's conversation so far into the call state: the caller's lines through the guardrails, the assistant's as said. */
  function sync(s: Session, lines: VapiLine[] | undefined) {
    // a demo call turned away hears its one line and ends: nothing a caller says there is acted on
    if (!lines || s.refused) return;
    for (const l of lines) {
      if (!spoken(l)) continue;
      const span = { who: whoOf(l), start: startOf(l), end: endOf(l) };
      if (s.fed.some((f) => f.who === span.who && overlaps(f, span))) continue;
      s.fed.push(span);
      let said = (l.message ?? '').trim();
      // the caller's words already given from the final transcripts (lookup-ahead): only what this line adds
      if (l.role === 'user' && s.early) {
        const { rest, early } = afterEarly(said, s.early);
        s.early = early;
        if (rest === '') continue;
        if (rest !== null) said = rest;
      }
      // the assistant's words with Vapi's spaced times read as clock times ("8 30 AM" is 8:30), for the read-back check
      const text = l.role === 'user' ? said : fromVapiVoice(said);
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
        correctCallerId(s, text);
      }
    }
  }

  /**
   * A final transcript of the caller's words (lookup-ahead, call speed 2026-11-19): the words go to the agent at once
   * (its guardrails hear them, as from Vapi's line), timed just after the last line fed; then the lookups they ask for
   * (flow/speculate.ts, at most two) run, and each result is added to Vapi's conversation without a reply of its own.
   * When it lands before Vapi's model runs, the model answers from it in one round; when it lands after, a tool call for
   * the same thing answers from the call's memory. Vapi's own line for these words is later fed only for what it adds.
   */
  async function lookAhead(s: Session, words: string) {
    const at = Math.max(Date.now() - s.startedAt, ...s.fed.map((f) => f.end + 1));
    s.early = [s.early, normalWords(words)].filter(Boolean).join(' ');
    act(s, s.agent.onCallerTranscript(words, at, at + 1));
    s.events.add({ type: 'vapi.transcript.final' });
    const ran = new Set<string>();
    for (let i = 0; i < LOOKUPS_AHEAD_MAX && !s.closed; i++) {
      const spec = s.agent.speculate();
      if (!spec || ran.has(spec.name)) break;
      ran.add(spec.name);
      const { output, controls } = await s.agent.onToolCall(spec.name, spec.args);
      act(s, controls);
      withCallerId(s, spec.name, output);
      s.events.add({ type: `lookahead.${spec.name}` });
      deps.log.info({ call_id: s.callId, tool: spec.name }, 'vapi: lookup run ahead of the reply');
      const content = forVapiVoice(`A lookup for the caller's last words has already run: ${spec.name} returned ${JSON.stringify(output)}. Answer from it now, following its say and spoken; do not call ${spec.name} again for the same details.`);
      controlSoon(s, { type: 'add-message', message: { role: 'system', content }, triggerResponseEnabled: false });
      if (!output.ok) break;
    }
  }

  app.post(VAPI_EVENTS_PATH, async (req, reply) => {
    // the secret first, before the body is read: a request without the location's secret learns nothing
    const clinicId = (req.query as { clinic?: string }).clinic;
    if (!clinicId || !CLINIC_ID.test(clinicId) || !(await authorised(clinicId, presentedOf(req.headers)))) return reply.code(401).send({ error: 'unauthorized' });
    let m: VapiMessage;
    try { m = (JSON.parse(req.body as string) as { message?: VapiMessage }).message ?? {}; } catch { return reply.code(400).send({ error: 'invalid body' }); }
    for (const [id, s] of sessions) if (Date.now() - s.startedAt > SESSION_TTL_MS) { sessions.delete(id); deps.live?.end(s.callId, s.agent.state.outcome); void s.events.close(); }
    if (refused.size > 10_000) refused.clear();
    const vapiId = m.call?.id;

    // the calls live at once, for Vapi's limit: from the call's status, or its first tool call if the status was missed
    if (vapiId && m.type === 'status-update' && m.status === 'in-progress') await live(vapiId);
    if (vapiId && ((m.type === 'status-update' && m.status === 'ended') || m.type === 'end-of-call-report')) {
      const known = sessions.get(vapiId);
      if (known) { known.over = true; deps.live?.end(known.callId, known.agent.state.outcome); }
      await ended(vapiId);
    }
    // money: Vapi has no API for its credit, so a call it would not start for credit is how we hear it ran out (P0)
    if (isVapiCreditEnd(m.endedReason)) deps.alerts?.alert('vapi_credit_low', `Vapi would not start a call (${m.endedReason}): the Vapi credit is used up or billing is frozen. Calls to Vapi locations go to Twilio's fallback.`, { clinicId });
    else if (isVapiOpenAiQuotaEnd(m.endedReason)) deps.alerts?.alert('openai_quota', `A Vapi call ended because OpenAI refused it (${m.endedReason}): the credit or quota is used up.`, { clinicId });

    // the caller's words as soon as the transcriber has them, before Vapi's model runs: given to the agent now, and the
    // lookup they ask for run and added to the conversation, so the model can answer from it (lookup-ahead)
    if (m.type?.startsWith('transcript') && m.transcriptType === 'final' && m.role === 'user' && vapiId) {
      const s = sessions.get(vapiId);
      const words = (m.transcript ?? '').trim();
      if (s && !s.refused && !s.closed && words) await lookAhead(s, words);
      return reply.code(200).send({});
    }
    if (m.type === 'tool-calls') {
      if (vapiId && !sessions.has(vapiId)) await live(vapiId);
      const s = await session(m, clinicId);
      if (!s || s.refused) return reply.code(200).send({ results: (m.toolCallList ?? []).map((t) => ({ toolCallId: t.id, error: 'This call cannot be helped here.' })) });
      s.events.add({ type: 'vapi.tool-calls' });
      for (const t of m.toolCallList ?? []) s.events.add({ type: 'vapi.tool_call', itemId: t.id });
      // the call facts never sent (no control URL yet): with this result, before anything else
      if (s.facts) { s.notes.unshift(s.facts); s.facts = null; }
      sync(s, m.artifact?.messages);
      const results = [];
      for (const t of m.toolCallList ?? []) {
        const args = typeof t.function?.arguments === 'string' ? safeJson(t.function.arguments) : t.function?.arguments ?? {};
        const { output, controls } = await s.agent.onToolCall(t.function?.name ?? '', args);
        // a transfer or the end of the call that a tool decided happens after its line is said, as on our engines
        act(s, controls);
        withCallerId(s, t.function?.name ?? '', output);
        // Vapi's voice hears what could not go through the control URL with the result: an emergency script first
        const notes = s.notes.splice(0);
        // in the words Vapi's voice says right: "Doctor Maya Chen", "8, 8:30 or 9 AM" (forVapiVoice, V3)
        results.push({ toolCallId: t.id, result: forVapiVoice(JSON.stringify(notes.length ? { ...output, say: [notes.join(' '), output.say].filter(Boolean).join(' ') } : output)) });
      }
      return reply.code(200).send({ results });
    }
    // the call is ours from its first message (its status, or the conversation): our guardrails hear the caller's words
    // even when the model calls no tool (an emergency in the first sentence), and the call is on file from its start
    const opens = m.type === 'conversation-update' || m.type === 'end-of-call-report' || (m.type === 'status-update' && m.status === 'in-progress');
    const s = vapiId ? sessions.get(vapiId) ?? (opens ? await session(m, clinicId) ?? undefined : undefined) : undefined;
    if (s) {
      s.controlUrl ??= controlUrlOf(m); sendFacts(s); flushPending(s);
      // the message's kind (and a status's name), never its content
      if (typeof m.type === 'string') s.events.add({ type: `vapi.${m.type}${m.type === 'status-update' && typeof m.status === 'string' ? `.${m.status}` : ''}` });
    }
    if (m.type === 'conversation-update' && s) sync(s, m.messages);
    if (m.type === 'end-of-call-report' && s) {
      const lines = m.artifact?.messages ?? [];
      sync(s, lines);
      s.closed = true;
      // off the live strip (if Vapi's ended status did not already take it off), with how it ended
      deps.live?.end(s.callId, s.agent.state.outcome);
      // a change waiting for a yes when the call ended becomes a request for the team (note 45, A4), as on our engines
      await s.agent.onCallEnd();
      // the waits for an answer that needed our tools, and the first audio, from Vapi's own times: as exact as our engines'
      for (const w of vapiAnswerWaits(lines)) s.agent.recordAnswerTiming({ ...w, flow: 'tools' });
      const recorder = deps.recorderFor(s.clinicId, s.callId);
      // the record from Vapi's final transcript, each line once (what the agent was fed came in windows, line by line);
      // without one, what the agent was fed
      const record = lines.some(spoken) ? vapiRecordLines(lines) : s.agent.state.turns.map((t) => ({ speaker: t.speaker, text: t.text, startMs: t.startMs, endMs: t.endMs }));
      // the longest wait from each piece of speech, as on our own engines (T4)
      const pieces = lines.some(spoken) ? record : s.agent.state.speech;
      for (const line of record) await recorder.appendSegment(line);
      await recorder.close({ reason: m.endedReason ?? 'ended', voiceSeconds: typeof m.durationSeconds === 'number' ? m.durationSeconds : null, outcome: s.agent.state.outcome, emergency: !!s.agent.state.emergency, emergencyResult: s.agent.state.emergencyResult, language: s.agent.state.language, quality: { firstAudioMs: vapiFirstAudioMs(lines), stalls: 0, answerTimeouts: 0, maxGapMs: longestWaitMs(pieces), repeatedQuestions: repeatedQuestions(record).length }, usage: { models: s.agent.state.modelTokens, ...(typeof m.cost === 'number' && m.cost >= 0 ? { engineUsd: m.cost } : {}) } });
      sessions.delete(vapiId!);
      // the call's turns on Vapi's own clock, then the rest of the log written
      for (const e of vapiTurnEvents(lines)) s.events.add(e);
      const logged = await s.events.close();
      if (logged.dropped) deps.log.warn({ call_id: s.callId, ...logged }, 'vapi: call events dropped');
      deps.log.info({ call_id: s.callId, engine: 'vapi', reason: m.endedReason ?? 'ended' }, 'vapi call closed');
    }
    return reply.code(200).send({});
  });

  return {
    liveCalls: () => {
      let n = 0;
      for (const s of sessions.values()) if (!s.over && !s.closed && Date.now() - s.startedAt <= SESSION_TTL_MS) n++;
      return n;
    },
  };
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
