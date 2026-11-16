// SPDX-License-Identifier: AGPL-3.0-only
import { callPath, dailyNumbers, maskQaTranscript, type PathNumbers, turnTimings } from '@attendra/core';
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { type Database, withClinic } from '../client';
import { type PhiCipher } from '../crypto';
import { appointments, auditLogs, smsMessages, tasks } from '../schema';
import { clinicDay, type DayCall, dayCallsIn, numbersCallsOf } from './call-events';

/** Who read the export, for its audit row: a key (`api_key:<id>`) or a signed-in person (`user:<id>`). */
export type QaReader = { keyId: string } | { userId: string };

/** One call in the export: codes, times and the masked transcript. No text body, no caller number. */
export interface QaCall {
  id: string;
  path: string;
  startedAt: string;
  endedAt: string | null;
  durationS: number | null;
  endReason: string | null;
  outcome: string | null;
  testCall: boolean;
  requests: { number: number; kind: string; status: string; urgent: boolean; origin: string | null; outcome: string | null }[];
  bookings: { change: 'booked' | 'cancelled'; status: string; visitTypeId: string; startsAt: string }[];
  texts: { template: string; kind: string; status: string; errorCode: string | null }[];
  events: {
    count: number; callerTurns: number; stalls: number; replyMs: number[];
    /** The turn gate's decisions and the provider's errors, by type or code: how often each happened. */
    gate: Record<string, number>; errors: Record<string, number>;
  } | null;
  transcript: { speaker: 'caller' | 'assistant'; startMs: number; endMs: number; text: string }[] | null;
}

export interface QaExportData { day: string; timezone: string; truncated: boolean; calls: QaCall[]; numbers: PathNumbers[] }

const count = (keys: string[]) => keys.reduce<Record<string, number>>((o, k) => ({ ...o, [k]: (o[k] ?? 0) + 1 }), {});

function eventSummary(c: DayCall): QaCall['events'] {
  if (!c.events.length) return null;
  const t = turnTimings(c.events);
  return {
    count: c.events.reduce((n, e) => n + e.n, 0), callerTurns: t.turns, stalls: t.stalls, replyMs: t.replyMs,
    gate: count(c.events.filter((e) => e.type.startsWith('gate.') || e.type.startsWith('runner.')).map((e) => e.type)),
    errors: count(c.events.filter((e) => e.type === 'error').map((e) => `${e.errorType ?? 'unknown'}/${e.errorCode ?? 'unknown'}`)),
  };
}

/**
 * The QA export (foundation A, item 1): one clinic day of calls (the clinic's own day, default yesterday), read-only, for
 * quality review. Each call: its path, times, end reason, outcome, test-call flag, the requests, bookings and texts it
 * made (kinds and statuses, never a text's words), its event-log summary, and its transcript with numbers masked (core
 * maskQaTranscript); and the day's numbers per path. The read and its audit row (`qa.export`, with the key's id or the
 * person's) commit together; a key's last use is set. Null for no clinic.
 */
export async function qaExport(db: Database, cipher: PhiCipher, clinicId: string, day: string | null, reader: QaReader, now = new Date()): Promise<QaExportData | null> {
  const d = await clinicDay(db, clinicId, day, now);
  if (!d) return null;
  return withClinic(db, clinicId, async (tx) => {
    const { calls: list, truncated } = await dayCallsIn(tx, cipher, clinicId, d.from, d.to);
    const ids = list.map((c) => c.id);
    const reqs = ids.length ? await tx.select({ callId: tasks.callId, number: tasks.number, kind: tasks.type, status: tasks.status, urgent: tasks.urgent, origin: tasks.origin, outcome: tasks.outcome })
      .from(tasks).where(and(eq(tasks.clinicId, clinicId), inArray(tasks.callId, ids))).orderBy(asc(tasks.number)) : [];
    const visits = ids.length ? await tx.select({ createdBy: appointments.createdByCallId, cancelledBy: appointments.cancelledByCallId, status: appointments.status, visitTypeId: appointments.visitTypeId, startsAt: appointments.startsAt })
      .from(appointments).where(and(eq(appointments.clinicId, clinicId), or(inArray(appointments.createdByCallId, ids), inArray(appointments.cancelledByCallId, ids)))).orderBy(asc(appointments.startsAt)) : [];
    const texts = ids.length ? await tx.select({ callId: smsMessages.callId, template: smsMessages.template, kind: smsMessages.kind, status: smsMessages.status, errorCode: smsMessages.errorCode })
      .from(smsMessages).where(and(eq(smsMessages.clinicId, clinicId), inArray(smsMessages.callId, ids))).orderBy(asc(smsMessages.createdAt)) : [];
    const out: QaCall[] = list.map((c) => ({
      id: c.id, path: callPath(c.engine, c.voiceFlow), startedAt: c.startedAt.toISOString(), endedAt: c.endedAt?.toISOString() ?? null,
      durationS: c.endedAt ? Math.round((c.endedAt.getTime() - c.startedAt.getTime()) / 1000) : null,
      endReason: c.closeReason, outcome: c.outcome, testCall: c.channel === 'web',
      requests: reqs.filter((r) => r.callId === c.id).map(({ callId: _, ...r }) => r),
      bookings: [
        ...visits.filter((v) => v.createdBy === c.id).map((v) => ({ change: 'booked' as const, status: v.status, visitTypeId: v.visitTypeId, startsAt: v.startsAt.toISOString() })),
        ...visits.filter((v) => v.cancelledBy === c.id && v.createdBy !== c.id).map((v) => ({ change: 'cancelled' as const, status: v.status, visitTypeId: v.visitTypeId, startsAt: v.startsAt.toISOString() })),
      ],
      texts: texts.filter((t) => t.callId === c.id).map(({ callId: _, ...t }) => t),
      events: eventSummary(c),
      transcript: c.lines ? maskQaTranscript(c.lines).map((l) => ({ speaker: l.speaker === 'agent' ? 'assistant' as const : 'caller' as const, startMs: l.startMs, endMs: l.endMs, text: l.text })) : null,
    }));
    const lines = out.reduce((n, c) => n + (c.transcript?.length ?? 0), 0);
    const actor = 'keyId' in reader ? `api_key:${reader.keyId}` : `user:${reader.userId}`;
    await tx.insert(auditLogs).values({ clinicId, actor, action: 'qa.export', entity: 'keyId' in reader ? 'api_key' : 'clinic', entityId: 'keyId' in reader ? reader.keyId : clinicId, counts: { calls: out.length, lines } });
    if ('keyId' in reader) await tx.execute(sql`update api_keys set last_used_at = now() where clinic_id = ${clinicId} and id = ${reader.keyId}`);
    return { day: d.day, timezone: d.timezone, truncated, calls: out, numbers: dailyNumbers(numbersCallsOf(list)) };
  });
}
