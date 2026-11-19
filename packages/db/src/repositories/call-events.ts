// SPDX-License-Identifier: AGPL-3.0-only
import {
  addDays, type CallEvent, type CallEventInput, type CallEventSink, callPath, cleanEvent, dailyNumbers, folds, localDateOf, type NumbersCall, type PathNumbers, type SpeedCall, zonedInstant,
} from '@attendra/core';
import { and, asc, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { type Database, setClinicScope, type Tx, withClinic } from '../client';
import { type PhiCipher, phiContext } from '../crypto';
import { auditLogs, callActions, callEvents, calls, callSegments, clinics } from '../schema';
import { PURGE_BATCH } from './summaries';

export interface CallEventLogOptions {
  /** How often the buffer is written while the call runs. */
  flushMs?: number;
  /** The most rows one call keeps; past it, events are counted as dropped. */
  maxRows?: number;
  /** The clock, in ms; the call's start is when the log was made. */
  now?: () => number;
  /** A failed write (logged by the caller, never thrown). */
  onError?: (err: unknown) => void;
}

/**
 * One call's event log (foundation A, item 2): events are kept in memory and written in one insert every few seconds
 * and at the call's end, so the database is not hit per event. A run of the same delta event is folded into one row.
 * Everything goes through core cleanEvent first: only the type, the ids and an error's code and type are kept.
 */
export class CallEventLog implements CallEventSink {
  private buffer: CallEvent[] = [];
  private seq = 0;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private writing: Promise<void> = Promise.resolve();
  private readonly startedAt: number;
  private written = 0;
  private dropped = 0;

  constructor(private readonly db: Database, private readonly clinicId: string, private readonly callId: string, private readonly path: string, private readonly opts: CallEventLogOptions = {}) {
    this.startedAt = (opts.now ?? Date.now)();
  }

  add(e: CallEventInput): void {
    try {
      if (this.closed) return;
      const atMs = Math.max(0, Math.round(typeof e.atMs === 'number' && Number.isFinite(e.atMs) ? e.atMs : (this.opts.now ?? Date.now)() - this.startedAt));
      const clean = cleanEvent(e);
      const row = { atMs, type: clean.type, responseId: clean.responseId ?? null, itemId: clean.itemId ?? null, errorCode: clean.errorCode ?? null, errorType: clean.errorType ?? null };
      const prev = this.buffer.at(-1);
      if (prev && folds(prev, row)) { prev.n++; prev.lastMs = Math.max(prev.atMs, atMs, prev.lastMs ?? 0); return; }
      if (this.seq >= (this.opts.maxRows ?? 5000)) { this.dropped++; return; }
      this.buffer.push({ seq: this.seq++, n: 1, lastMs: null, ...row });
      if (!this.timer) {
        this.timer = setInterval(() => void this.flush(), this.opts.flushMs ?? 3000);
        this.timer.unref?.();
      }
    } catch {
      this.dropped++;
    }
  }

  /** Writes the buffer as one insert, after any write still going. A failure drops that batch and is reported. */
  flush(): Promise<void> {
    const rows = this.buffer.splice(0);
    if (!rows.length) return this.writing;
    this.writing = this.writing.then(() => withClinic(this.db, this.clinicId, async (tx) => {
      await tx.insert(callEvents).values(rows.map((r) => ({ clinicId: this.clinicId, callId: this.callId, path: this.path, ...r })));
    })).then(() => { this.written += rows.length; }, (err: unknown) => {
      this.dropped += rows.reduce((n, r) => n + r.n, 0);
      try { this.opts.onError?.(err); } catch { /* the caller's logger: never into the call */ }
    });
    return this.writing;
  }

  async close() {
    if (!this.closed) {
      this.closed = true;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      await this.flush();
    }
    await this.writing;
    return { written: this.written, dropped: this.dropped };
  }
}

const toEvent = (r: { seq: number; atMs: number; type: string; n: number; lastMs: number | null; responseId: string | null; itemId: string | null; errorCode: string | null; errorType: string | null }): CallEvent => ({
  seq: r.seq, atMs: r.atMs, type: r.type, n: r.n, lastMs: r.lastMs, responseId: r.responseId, itemId: r.itemId, errorCode: r.errorCode, errorType: r.errorType,
});
const EVENT_COLUMNS = {
  callId: callEvents.callId, path: callEvents.path, seq: callEvents.seq, atMs: callEvents.atMs, type: callEvents.type, n: callEvents.n, lastMs: callEvents.lastMs,
  responseId: callEvents.responseId, itemId: callEvents.itemId, errorCode: callEvents.errorCode, errorType: callEvents.errorType,
};

/** The logs of some of a clinic's calls, by call id, each in order, inside a transaction the clinic is set on. */
export async function callEventsIn(tx: Tx, clinicId: string, callIds: string[]): Promise<Map<string, CallEvent[]>> {
  const out = new Map<string, CallEvent[]>();
  if (!callIds.length) return out;
  const rows = await tx.select(EVENT_COLUMNS).from(callEvents).where(and(eq(callEvents.clinicId, clinicId), inArray(callEvents.callId, callIds))).orderBy(asc(callEvents.callId), asc(callEvents.seq));
  for (const r of rows) out.set(r.callId, [...(out.get(r.callId) ?? []), toEvent(r)]);
  return out;
}

/** One call's log, in order: empty when it has none. */
export async function callEventsOf(db: Database, clinicId: string, callId: string): Promise<CallEvent[]> {
  return withClinic(db, clinicId, async (tx) => (await callEventsIn(tx, clinicId, [callId])).get(callId) ?? []);
}

/**
 * A call's log found by its id alone, for `pnpm db:call-events`: each clinic is tried in its own scope, as the tenancy
 * rules require. Null when no clinic has the call.
 */
export async function findCallEvents(db: Database, callId: string): Promise<{ clinicId: string; path: string; startedAt: Date; events: CallEvent[] } | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(callId)) throw new Error('a call id is a UUID');
  for (const { id: clinicId } of await db.select({ id: clinics.id }).from(clinics).orderBy(clinics.id)) {
    const found = await withClinic(db, clinicId, async (tx) => {
      const [call] = await tx.select({ engine: calls.engine, flow: calls.voiceFlow, startedAt: calls.startedAt }).from(calls).where(and(eq(calls.clinicId, clinicId), eq(calls.id, callId)));
      if (!call) return null;
      const rows = await tx.select(EVENT_COLUMNS).from(callEvents).where(and(eq(callEvents.clinicId, clinicId), eq(callEvents.callId, callId))).orderBy(asc(callEvents.seq));
      return { clinicId, path: rows[0]?.path ?? callPath(call.engine, call.flow), startedAt: call.startedAt, events: rows.map(toEvent) };
    });
    if (found) return found;
  }
  return null;
}

/**
 * Deletes a clinic's call events written before `before` (7 days: core CALL_EVENTS_RETENTION_DAYS), in batches, each
 * with an audit row of its count in the same transaction, like the other purges. On the services' role in the clinic's
 * scope: the application role cannot delete them.
 */
export async function purgeCallEvents(db: Database, clinicId: string, before: Date, batch = PURGE_BATCH): Promise<{ callEvents: number }> {
  let total = 0;
  for (;;) {
    const n = await db.transaction(async (tx) => {
      await setClinicScope(tx, clinicId);
      const gone = (await tx.execute(sql`delete from call_events where id in (
        select id from call_events where clinic_id = ${clinicId} and created_at < ${before.toISOString()}::timestamptz order by id limit ${batch}) returning id`)).rows.length;
      if (gone) await tx.insert(auditLogs).values({ clinicId, actor: 'worker', action: 'retention.purged', entity: 'clinic', entityId: clinicId, counts: { callEvents: gone } });
      return gone;
    });
    total += n;
    if (n < batch) break;
  }
  return { callEvents: total };
}

/** A clinic's own day ("2026-11-16", its clock), as the instants it starts and ends, and the clinic's time zone. */
export async function clinicDay(db: Database, clinicId: string, day: string | null, now: Date): Promise<{ day: string; timezone: string; from: Date; to: Date } | null> {
  const [row] = await db.select({ timezone: clinics.timezone }).from(clinics).where(eq(clinics.id, clinicId));
  if (!row) return null;
  const d = day ?? addDays(localDateOf(now, row.timezone), -1);
  return { day: d, timezone: row.timezone, from: zonedInstant(d, '00:00', row.timezone), to: zonedInstant(addDays(d, 1), '00:00', row.timezone) };
}

/** One of the day's calls with what the numbers and the QA export read. */
export interface DayCall {
  id: string; engine: string | null; voiceFlow: string | null; channel: 'phone' | 'web'; startedAt: Date; endedAt: Date | null;
  outcome: string | null; closeReason: string | null; stalls: number | null;
  events: CallEvent[];
  refusals: { tool: string; code: string }[];
  /** Decrypted in memory; null when the transcript is gone. */
  lines: { speaker: 'caller' | 'agent'; text: string; startMs: number; endMs: number }[] | null;
}

/** The most calls one day's read takes; a day with more says so (the QA export's `truncated`). */
export const DAY_CALLS_MAX = 1000;

/** The calls that started in [from, to), oldest first, with their logs, refusals and lines, inside the clinic's transaction. */
export async function dayCallsIn(tx: Tx, cipher: PhiCipher, clinicId: string, from: Date, to: Date, max = DAY_CALLS_MAX): Promise<{ calls: DayCall[]; truncated: boolean }> {
  const list = await tx.select({
    id: calls.id, engine: calls.engine, voiceFlow: calls.voiceFlow, channel: calls.channel, startedAt: calls.startedAt, endedAt: calls.endedAt,
    outcome: calls.outcome, closeReason: calls.closeReason, stalls: calls.stalls,
  }).from(calls).where(and(eq(calls.clinicId, clinicId), gte(calls.startedAt, from), lt(calls.startedAt, to))).orderBy(asc(calls.startedAt), asc(calls.id)).limit(max + 1);
  const truncated = list.length > max;
  const day = list.slice(0, max);
  if (!day.length) return { calls: [], truncated };
  const ids = day.map((c) => c.id);
  const events = await callEventsIn(tx, clinicId, ids);
  const refusals = await tx.select({ callId: callActions.callId, tool: callActions.tool, code: sql<string>`${callActions.result}->>'error'` }).from(callActions)
    .where(and(eq(callActions.clinicId, clinicId), inArray(callActions.callId, ids), isNotNull(sql`${callActions.result}->>'error'`))).orderBy(asc(callActions.id));
  const segs = await tx.select({ callId: callSegments.callId, speaker: callSegments.speaker, textEnc: callSegments.textEnc, startMs: callSegments.startMs, endMs: callSegments.endMs })
    .from(callSegments).where(and(eq(callSegments.clinicId, clinicId), inArray(callSegments.callId, ids))).orderBy(asc(callSegments.startMs), asc(callSegments.id));
  const ctx = phiContext(clinicId, 'call_segments.text');
  const lines = new Map<string, NonNullable<DayCall['lines']>>();
  for (const s of segs) lines.set(s.callId, [...(lines.get(s.callId) ?? []), { speaker: s.speaker, text: cipher.decrypt(s.textEnc, ctx), startMs: s.startMs, endMs: s.endMs }]);
  return {
    truncated,
    calls: day.map((c) => ({
      ...c, events: events.get(c.id) ?? [], refusals: refusals.filter((r) => r.callId === c.id).map((r) => ({ tool: r.tool, code: r.code })),
      // a call that ended with lines has them; one with none (retention, or a call nobody spoke on) reads as gone
      lines: lines.get(c.id) ?? null,
    })),
  };
}

/** The day's calls as the daily numbers read them: words in memory only. */
export const numbersCallsOf = (day: DayCall[]): NumbersCall[] => day.map((c) => ({
  id: c.id, path: callPath(c.engine, c.voiceFlow), testCall: c.channel === 'web', runnerStalls: c.engine === 'vapi' ? null : c.stalls,
  events: c.events, refusals: c.refusals, agentLines: c.lines ? c.lines.filter((l) => l.speaker === 'agent').map((l) => l.text) : null,
}));

/**
 * A clinic's daily numbers (foundation A, item 7) for its own day (default: yesterday, its clock), per call path: the
 * one function the QA export's `numbers` and `pnpm db:call-numbers` use. Counts and times only. Null for no clinic.
 */
export async function callNumbers(db: Database, cipher: PhiCipher, clinicId: string, day: string | null, now = new Date()): Promise<{ day: string; timezone: string; calls: number; truncated: boolean; paths: PathNumbers[] } | null> {
  const d = await clinicDay(db, clinicId, day, now);
  if (!d) return null;
  const read = await withClinic(db, clinicId, (tx) => dayCallsIn(tx, cipher, clinicId, d.from, d.to));
  return { day: d.day, timezone: d.timezone, calls: read.calls.length, truncated: read.truncated, paths: dailyNumbers(numbersCallsOf(read.calls)) };
}

/**
 * Call speed (2026-11-19) for a clinic's calls that started in [from, to): each call's path and event log, nothing else
 * (no words are read). One transaction in the clinic's scope; at most DAY_CALLS_MAX calls.
 */
export async function speedCallsIn(db: Database, clinicId: string, from: Date, to: Date): Promise<SpeedCall[]> {
  return withClinic(db, clinicId, async (tx) => {
    const list = await tx.select({ id: calls.id, engine: calls.engine, voiceFlow: calls.voiceFlow }).from(calls)
      .where(and(eq(calls.clinicId, clinicId), gte(calls.startedAt, from), lt(calls.startedAt, to))).orderBy(asc(calls.startedAt), asc(calls.id)).limit(DAY_CALLS_MAX);
    const events = await callEventsIn(tx, clinicId, list.map((c) => c.id));
    return list.map((c) => ({ path: callPath(c.engine, c.voiceFlow), events: events.get(c.id) ?? [] })).filter((c) => c.events.length);
  });
}
