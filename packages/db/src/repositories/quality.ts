// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { type Database, withClinic } from '../client';

/** One phone call, for the quality page: codes, counts and times. No names, no transcript. */
export interface QualityRow {
  callId: string;
  startedAt: Date;
  outcome: string | null;
  closeReason: string | null;
  voiceSeconds: number;
  emergency: boolean;
  flagged: boolean;
  triedToBook: boolean;
  callerTurns: number;
  refusals: string[];
  refillRequests: number;
}

/**
 * Every phone call in a period with what the quality page needs, counted in the
 * database. Browser test calls are left out, as they are from the overview.
 */
export async function qualityRows(db: Database, clinicId: string, from: Date, to: Date): Promise<QualityRow[]> {
  return withClinic(db, clinicId, async (tx) => (await tx.execute(sql`
    select c.id, c.started_at, c.outcome, c.close_reason, coalesce(c.voice_seconds, 0)::float as voice_seconds, c.emergency_flag,
      coalesce(s.needs_review, false) as flagged,
      exists (select 1 from call_actions a where a.call_id = c.id and a.tool = 'propose_booking') as tried_to_book,
      (select count(*)::int from call_segments g where g.call_id = c.id and g.speaker = 'caller') as caller_turns,
      (select count(*)::int from tasks t where t.call_id = c.id and t.type = 'refill') as refill_requests,
      coalesce((select array_agg(a.result->>'error') from call_actions a where a.call_id = c.id and a.result->>'error' is not null), '{}') as refusals
    from calls c left join call_summaries s on s.call_id = c.id
    where c.clinic_id = ${clinicId} and c.channel = 'phone' and c.started_at >= ${from} and c.started_at < ${to}
    order by c.started_at`)).rows.map((r: unknown) => {
    const x = r as Record<string, unknown>;
    return {
      callId: String(x.id), startedAt: new Date(x.started_at as string), outcome: (x.outcome as string | null) ?? null, closeReason: (x.close_reason as string | null) ?? null,
      voiceSeconds: Number(x.voice_seconds), emergency: !!x.emergency_flag, flagged: !!x.flagged, triedToBook: !!x.tried_to_book,
      callerTurns: Number(x.caller_turns), refusals: (x.refusals as string[]) ?? [], refillRequests: Number(x.refill_requests),
    };
  }));
}

/**
 * When each browser test call in a period started. The quality page counts real phone
 * calls only; it counts these to say how many it left out, so a week of test calls is
 * never shown as "no calls" without a word.
 */
export async function testCallStarts(db: Database, clinicId: string, from: Date, to: Date): Promise<Date[]> {
  return withClinic(db, clinicId, async (tx) => (await tx.execute(sql`
    select started_at from calls where clinic_id = ${clinicId} and channel = 'web' and started_at >= ${from} and started_at < ${to} order by started_at`))
    .rows.map((r: unknown) => new Date((r as { started_at: string }).started_at)));
}

/** When the clinic was set up: the quality page's weeks start from the week it signed up. */
export async function clinicSince(db: Database, clinicId: string): Promise<Date | null> {
  return withClinic(db, clinicId, async (tx) => {
    const [r] = (await tx.execute(sql`select created_at from clinics where id = ${clinicId}`)).rows as { created_at: string }[];
    return r ? new Date(r.created_at) : null;
  });
}

/**
 * The visits that were due in a period and have started by `now`, whatever the desk marked
 * them (booked, arrived, completed, no-show): when each started and its state, for the
 * quality page's no-shows. Cancelled visits are not counted. No patient data.
 */
export async function visitsDue(db: Database, clinicId: string, from: Date, to: Date, now: Date): Promise<{ startsAt: Date; status: string }[]> {
  const until = now < to ? now : to;
  return withClinic(db, clinicId, async (tx) => (await tx.execute(sql`
    select starts_at, status from appointments where clinic_id = ${clinicId} and status <> 'cancelled' and starts_at >= ${from} and starts_at <= ${until} order by starts_at`))
    .rows.map((r: unknown) => { const x = r as { starts_at: string; status: string }; return { startsAt: new Date(x.starts_at), status: x.status }; }));
}
