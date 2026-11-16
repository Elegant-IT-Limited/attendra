// SPDX-License-Identifier: AGPL-3.0-only
import { STALL_MS } from './call-markers';

/**
 * The per-call event log (foundation A, item 2): every event the voice provider sends on a call, as its type, when it
 * came (ms from the call's start), the response and item it belongs to, and for an `error` only its code and type. Never
 * content: no transcript, no delta, no tool arguments, no audio, no error message. What goes in is cut down to those
 * fields here, and each field must look like an id (no spaces), so a sentence cannot reach the table even by mistake;
 * the table checks the same shapes (migration 0060).
 *
 * The turn gate's own decisions (gate.queued, gate.merged, gate.cleared_on_error...) and the runner's nudges go in the
 * same log, so a stall can be proven from it: the caller stopped, a request was queued, an error came, nothing went out.
 */

/** How long the log is kept: a week of calls, purged by the worker's nightly retention job. */
export const CALL_EVENTS_RETENTION_DAYS = 7;
/** A gap this long between two events is marked in the printed timeline. */
export const CALL_EVENT_GAP_MS = 2000;

/** An event type: lower case, digits and . _ : - only, at most 64 characters. */
export const CALL_EVENT_TYPE = /^[a-z0-9_.:-]{1,64}$/;
/** An id or a code: letters, digits and . _ : - only, at most 80 characters. Never a space, so never a sentence. */
export const CALL_EVENT_ID = /^[A-Za-z0-9_.:-]{1,80}$/;

/**
 * A call's path in the log and the daily numbers: its engine and how its turns are answered, as the call row has them
 * (engine, voice_flow). An engine the row does not name (an older call, the simulator) is `unknown`; no flow is `planner`.
 */
export const callPath = (engine: string | null | undefined, flow: string | null | undefined) =>
  `${engine && /^[a-z0-9_.-]{1,40}$/.test(engine) ? engine : 'unknown'}/${flow && /^[a-z0-9_.-]{1,40}$/.test(flow) ? flow : 'planner'}`;

/** One event as the voice service hands it to the log. `atMs`: when it happened, if not now (Vapi's own times). */
export interface CallEventInput {
  type: string;
  atMs?: number;
  responseId?: string | null;
  itemId?: string | null;
  errorCode?: string | null;
  errorType?: string | null;
}

/** Where a call's events go while it runs (packages/db CallEventLog). Never throws: a log that fails never fails the call. */
export interface CallEventSink {
  add(e: CallEventInput): void;
  /** Writes what is left; resolves with how many rows were written and how many events were dropped. */
  close(): Promise<{ written: number; dropped: number }>;
}

/** One stored row: an event, or a run of the same delta event folded into one (n of them, the last at lastMs). */
export interface CallEvent {
  seq: number;
  atMs: number;
  type: string;
  n: number;
  lastMs: number | null;
  responseId: string | null;
  itemId: string | null;
  errorCode: string | null;
  errorType: string | null;
}

const idOf = (v: unknown): string | null => (typeof v === 'string' && CALL_EVENT_ID.test(v) ? v : null);
const typeOf = (v: unknown): string => (typeof v === 'string' && CALL_EVENT_TYPE.test(v) ? v : 'unknown');
const field = (o: unknown, k: string): unknown => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined);

/**
 * A provider's event (OpenAI Realtime, GPT-Live's sideband) cut down to what the log keeps. Everything else in it
 * (transcripts, deltas, arguments, audio, an error's message) is never read. A GPT-Live delegated response's own events
 * are logged by their inner type ("response.event:response.output_item.done").
 */
export function providerEvent(e: Record<string, unknown>): CallEventInput {
  const inner = e.type === 'response.event' ? field(e, 'event') : undefined;
  const type = inner ? `response.event:${typeOf(field(inner, 'type'))}` : typeOf(e.type);
  const src = inner ?? e;
  const response = field(src, 'response');
  const item = field(src, 'item');
  const out: CallEventInput = {
    type: type.length > 64 ? 'unknown' : type,
    responseId: idOf(field(src, 'response_id')) ?? idOf(field(response, 'id')),
    itemId: idOf(field(src, 'item_id')) ?? idOf(field(item, 'id')) ?? idOf(field(src, 'call_id')) ?? idOf(field(field(src, 'delegation'), 'id')),
  };
  if (e.type === 'error') {
    const err = field(e, 'error');
    out.errorCode = idOf(field(err, 'code'));
    out.errorType = idOf(field(err, 'type'));
  }
  return out;
}

/** The fields of an input the log may keep, checked: an id that is not id-shaped is dropped, a type that is not becomes `unknown`. */
export function cleanEvent(e: CallEventInput): Omit<CallEventInput, 'atMs'> {
  const error = e.type === 'error';
  return {
    type: typeOf(e.type),
    responseId: idOf(e.responseId),
    itemId: idOf(e.itemId),
    errorCode: error ? idOf(e.errorCode) : null,
    errorType: error ? idOf(e.errorType) : null,
  };
}

/** Delta events come many a second: a run of one of them, for the same response and item, is one row with a count. */
export const folds = (prev: CallEvent | undefined, next: Omit<CallEvent, 'seq' | 'n' | 'lastMs'>) =>
  !!prev && prev.type === next.type && (next.type.endsWith('.delta') || next.type.endsWith('.appended')) && prev.responseId === next.responseId && prev.itemId === next.itemId;

/** When the caller stopped speaking, started speaking, and when the assistant's reply started, per call path. */
const CALLER_STOPPED = new Set(['input_audio_buffer.speech_stopped', 'vapi.caller.stopped']);
const CALLER_STARTED = new Set(['input_audio_buffer.speech_started', 'vapi.caller.started']);
const REPLY_STARTED = new Set(['output_audio_buffer.started', 'response.output_audio.delta', 'response.output_audio_transcript.delta', 'session.output_audio.delta', 'vapi.assistant.started']);

/** Whether a call's log says when the caller stopped speaking: without it, no reply time can be read from the log. */
export const hasTurnEnds = (events: readonly Pick<CallEvent, 'type'>[]) => events.some((e) => CALLER_STOPPED.has(e.type));

/**
 * The caller's turns on one call, from its log: for each time the caller stopped speaking, how long until the
 * assistant's reply started (`replyMs`), and the stalls: turns where no reply started within STALL_MS (the runner's
 * first nudge, the same 5 s), because nothing came, the caller spoke again first, or the call ended first.
 */
export function turnTimings(events: readonly Pick<CallEvent, 'type' | 'atMs'>[]): { turns: number; replyMs: number[]; stalls: number; stallAtMs: number[] } {
  const sorted = [...events].sort((a, b) => a.atMs - b.atMs);
  const end = sorted.at(-1)?.atMs ?? 0;
  const out = { turns: 0, replyMs: [] as number[], stalls: 0, stallAtMs: [] as number[] };
  for (let i = 0; i < sorted.length; i++) {
    if (!CALLER_STOPPED.has(sorted[i]!.type)) continue;
    const at = sorted[i]!.atMs;
    out.turns++;
    const next = sorted.slice(i + 1).find((e) => REPLY_STARTED.has(e.type) || CALLER_STARTED.has(e.type) || CALLER_STOPPED.has(e.type));
    const waited = (next?.atMs ?? end) - at;
    if (next && REPLY_STARTED.has(next.type)) out.replyMs.push(waited);
    if (waited > STALL_MS) { out.stalls++; out.stallAtMs.push(at); }
  }
  return out;
}

/** The log of one call as text: offset, type, response id (and item id, count, error code), with gaps over 2 s marked. */
export function formatCallEvents(head: string, events: readonly CallEvent[]): string[] {
  const lines = [head, 'offset_ms  gap_ms  type  response  item  n  error'];
  let last: number | null = null;
  for (const e of events) {
    const gap = last === null ? null : e.atMs - last;
    const mark = gap !== null && gap > CALL_EVENT_GAP_MS ? `  <-- gap ${(gap / 1000).toFixed(1)} s` : '';
    lines.push([String(e.atMs).padStart(8), gap === null ? '-' : String(gap), e.type, e.responseId ?? '-', e.itemId ?? '-', e.n > 1 ? `x${e.n}${e.lastMs !== null ? ` to ${e.lastMs}` : ''}` : '-',
      e.errorCode || e.errorType ? `${e.errorType ?? '?'}/${e.errorCode ?? '?'}` : '-'].join('  ') + mark);
    last = Math.max(last ?? 0, e.lastMs ?? e.atMs);
  }
  const t = turnTimings(events);
  lines.push(`caller turns: ${t.turns}; replies timed: ${t.replyMs.length}; stalls over ${STALL_MS / 1000} s: ${t.stalls}${t.stallAtMs.length ? ` (at ${t.stallAtMs.join(', ')} ms)` : ''}`);
  return lines;
}
