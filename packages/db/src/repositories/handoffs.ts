// SPDX-License-Identifier: AGPL-3.0-only
import { type ExcerptLine, HANDOFF_FIX_CATEGORIES, HANDOFF_REASONS, HANDOFF_VERDICTS, type HandoffFixCategory, type HandoffKind, type HandoffReason, type HandoffStep, type HandoffVerdict } from '@attendra/core';
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { type Database, withClinic } from '../client';
import { type PhiCipher, phiContext } from '../crypto';
import { auditLogs, calls, clinics, handoffs } from '../schema';

/**
 * The handoff review loop's records (note 47; migration 0057): one per handoff, codes only, with a masked and encrypted
 * excerpt where the clinic allows it. Every read and write is in the clinic's own scope (Row Level Security); a read
 * across clinics goes clinic by clinic. Reviews come from the Attendra team's back office, through the hosted service
 * and this engine's provisioning API: each view and each verdict is an audit row here too, by the reviewer's email.
 */
export interface HandoffInput {
  kind: HandoffKind;
  reason: HandoffReason;
  steps: HandoffStep[];
  lineId: string | null;
  /** Already masked (core maskExcerptLine); null when the clinic keeps no excerpts. */
  excerpt: ExcerptLine[] | null;
  at?: Date;
}

export interface HandoffRow {
  id: string; clinicId: string; clinicName: string; orgId: string; callId: string; at: string;
  engine: string; channel: string; kind: string; reason: string; steps: HandoffStep[]; lineId: string | null; hasExcerpt: boolean;
  verdict: HandoffVerdict | null; fixCategory: HandoffFixCategory | null; reviewedBy: string | null; reviewedAt: string | null;
}

export interface HandoffFilter { orgId?: string; clinicId?: string; clinicIds?: string[]; reason?: HandoffReason; engine?: string; verdict?: HandoffVerdict | 'unreviewed'; from?: Date; to?: Date; limit?: number }

const excerptContext = (clinicId: string) => phiContext(clinicId, 'handoffs.excerpt');

/** Records a handoff on a call: the engine and channel are the call's own, as it was opened. */
export async function recordHandoff(db: Database, cipher: PhiCipher, clinicId: string, callId: string, h: HandoffInput): Promise<string> {
  return withClinic(db, clinicId, async (tx) => {
    const [call] = await tx.select({ engine: calls.engine, channel: calls.channel }).from(calls).where(and(eq(calls.clinicId, clinicId), eq(calls.id, callId)));
    if (!call) throw new Error('handoff for a call this clinic does not have');
    const [row] = await tx.insert(handoffs).values({
      clinicId, callId, engine: call.engine ?? 'unknown', channel: call.channel, kind: h.kind, reason: h.reason,
      steps: h.steps, lineId: h.lineId, ...(h.at ? { at: h.at } : {}),
      excerptEnc: h.excerpt?.length ? cipher.encrypt(JSON.stringify(h.excerpt), excerptContext(clinicId)) : null,
    }).returning({ id: handoffs.id });
    return row!.id;
  });
}

type Raw = typeof handoffs.$inferSelect;
const rowOf = (r: Raw, clinic: { name: string; orgId: string }): HandoffRow => ({
  id: r.id, clinicId: r.clinicId, clinicName: clinic.name, orgId: clinic.orgId, callId: r.callId, at: r.at.toISOString(),
  engine: r.engine, channel: r.channel, kind: r.kind, reason: r.reason, steps: r.steps, lineId: r.lineId, hasExcerpt: !!r.excerptEnc,
  verdict: (r.verdict as HandoffVerdict | null) ?? null, fixCategory: (r.fixCategory as HandoffFixCategory | null) ?? null,
  reviewedBy: r.reviewedBy, reviewedAt: r.reviewedAt?.toISOString() ?? null,
});

/** The clinics a read across clinics covers: one, an account's, or all; with their name and account. */
async function clinicsFor(db: Database, f: Pick<HandoffFilter, 'orgId' | 'clinicId' | 'clinicIds'>) {
  const where = f.clinicId ? eq(clinics.id, f.clinicId) : f.clinicIds?.length ? inArray(clinics.id, f.clinicIds) : f.orgId ? eq(clinics.orgId, f.orgId) : undefined;
  return db.select({ id: clinics.id, name: clinics.name, orgId: clinics.orgId }).from(clinics).where(where);
}

/** Handoffs across clinics, newest first, with the filter's clinic, account, reason, engine, verdict and days. No excerpt. */
export async function listHandoffs(db: Database, f: HandoffFilter = {}): Promise<HandoffRow[]> {
  const limit = Math.min(Math.max(f.limit ?? 200, 1), 500);
  const out: HandoffRow[] = [];
  for (const c of await clinicsFor(db, f)) {
    const rows = await withClinic(db, c.id, (tx) => tx.select().from(handoffs).where(and(
      eq(handoffs.clinicId, c.id),
      f.reason ? eq(handoffs.reason, f.reason) : undefined,
      f.engine ? eq(handoffs.engine, f.engine) : undefined,
      f.verdict === 'unreviewed' ? sql`${handoffs.verdict} is null` : f.verdict ? eq(handoffs.verdict, f.verdict) : undefined,
      f.from ? gte(handoffs.at, f.from) : undefined,
      f.to ? lt(handoffs.at, f.to) : undefined,
    )).orderBy(desc(handoffs.at), desc(handoffs.id)).limit(limit));
    out.push(...rows.map((r) => rowOf(r, c)));
  }
  return out.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)).slice(0, limit);
}

/** One handoff with its masked excerpt, for the back office; the view is audited with who looked. Null when not found. */
export async function viewHandoff(db: Database, cipher: PhiCipher, clinicId: string, id: string, viewer: string): Promise<(HandoffRow & { excerpt: ExcerptLine[] | null }) | null> {
  const [clinic] = await clinicsFor(db, { clinicId });
  if (!clinic) return null;
  return withClinic(db, clinicId, async (tx) => {
    const [r] = await tx.select().from(handoffs).where(and(eq(handoffs.clinicId, clinicId), eq(handoffs.id, id)));
    if (!r) return null;
    await tx.insert(auditLogs).values({ clinicId, actor: `backoffice:${viewer}`, action: 'handoff.viewed', entity: 'handoff', entityId: id, callId: r.callId });
    const excerpt = r.excerptEnc ? JSON.parse(cipher.decrypt(r.excerptEnc, excerptContext(clinicId))) as ExcerptLine[] : null;
    return { ...rowOf(r, clinic), excerpt };
  });
}

/** The team's verdict on a handoff and what kind of fix it needs, audited with who set it. False when not found. */
export async function setHandoffVerdict(db: Database, clinicId: string, id: string, v: { verdict: HandoffVerdict; fixCategory: HandoffFixCategory | null; by: string }, at = new Date()): Promise<boolean> {
  if (!HANDOFF_VERDICTS.includes(v.verdict) || (v.fixCategory !== null && !HANDOFF_FIX_CATEGORIES.includes(v.fixCategory))) throw new Error('invalid verdict');
  return withClinic(db, clinicId, async (tx) => {
    const updated = await tx.update(handoffs).set({ verdict: v.verdict, fixCategory: v.fixCategory, reviewedBy: v.by, reviewedAt: at })
      .where(and(eq(handoffs.clinicId, clinicId), eq(handoffs.id, id))).returning({ id: handoffs.id, callId: handoffs.callId });
    if (!updated.length) return false;
    await tx.insert(auditLogs).values({ clinicId, actor: `backoffice:${v.by}`, action: `handoff.reviewed.${v.verdict}`, entity: 'handoff', entityId: id, callId: updated[0]!.callId });
    return true;
  });
}

/** A week's numbers for one clinic and engine: calls, calls with a handoff, handoffs, reviewed, "not needed", and reasons. */
export interface HandoffWeek {
  week: string; clinicId: string; clinicName: string; orgId: string; engine: string;
  calls: number; callsWithHandoff: number; handoffs: number; reviewed: number; notNeeded: number;
  /** Handoffs by reason, most first. */
  reasons: { reason: HandoffReason; count: number }[];
}

/**
 * Handoff numbers by clinic, engine and ISO week (Monday, UTC) in [from, to): the handoff rate is callsWithHandoff /
 * calls, the "not needed" rate notNeeded / reviewed. Browser test calls count, as the alpha's calls are mostly those.
 */
export async function handoffWeeks(db: Database, f: Pick<HandoffFilter, 'orgId' | 'clinicId' | 'clinicIds'> & { from: Date; to: Date }): Promise<HandoffWeek[]> {
  const out: HandoffWeek[] = [];
  for (const c of await clinicsFor(db, f)) {
    await withClinic(db, c.id, async (tx) => {
      const callRows = (await tx.execute(sql`
        select to_char(date_trunc('week', c.started_at at time zone 'UTC'), 'YYYY-MM-DD') as week, coalesce(c.engine, 'unknown') as engine,
          count(*)::int as calls, count(*) filter (where exists (select 1 from handoffs h where h.call_id = c.id and h.clinic_id = c.clinic_id))::int as with_handoff
        from calls c where c.clinic_id = ${c.id} and c.started_at >= ${f.from} and c.started_at < ${f.to}
        group by 1, 2`)).rows as { week: string; engine: string; calls: number; with_handoff: number }[];
      const handoffRows = (await tx.execute(sql`
        select to_char(date_trunc('week', h.at at time zone 'UTC'), 'YYYY-MM-DD') as week, h.engine, h.reason,
          count(*)::int as n, count(*) filter (where h.verdict is not null)::int as reviewed, count(*) filter (where h.verdict = 'not_needed')::int as not_needed
        from handoffs h where h.clinic_id = ${c.id} and h.at >= ${f.from} and h.at < ${f.to}
        group by 1, 2, 3`)).rows as { week: string; engine: string; reason: HandoffReason; n: number; reviewed: number; not_needed: number }[];
      const keys = new Set([...callRows.map((r) => `${r.week}|${r.engine}`), ...handoffRows.map((r) => `${r.week}|${r.engine}`)]);
      for (const key of keys) {
        const [week, engine] = key.split('|') as [string, string];
        const cr = callRows.find((r) => r.week === week && r.engine === engine);
        const hr = handoffRows.filter((r) => r.week === week && r.engine === engine);
        out.push({
          week, clinicId: c.id, clinicName: c.name, orgId: c.orgId, engine,
          calls: cr?.calls ?? 0, callsWithHandoff: cr?.with_handoff ?? 0,
          handoffs: hr.reduce((s, r) => s + r.n, 0), reviewed: hr.reduce((s, r) => s + r.reviewed, 0), notNeeded: hr.reduce((s, r) => s + r.not_needed, 0),
          reasons: HANDOFF_REASONS.map((reason) => ({ reason, count: hr.filter((r) => r.reason === reason).reduce((s, r) => s + r.n, 0) })).filter((r) => r.count).sort((a, b) => b.count - a.count),
        });
      }
    });
  }
  return out.sort((a, b) => b.week.localeCompare(a.week) || a.clinicName.localeCompare(b.clinicName) || a.engine.localeCompare(b.engine));
}

/**
 * Every handoff the team marked "not needed" whose review falls in [from, to): codes only, no caller words and no
 * excerpt, for the weekly export Claude turns into a scripted scenario and a fix note each.
 */
export async function notNeededHandoffs(db: Database, f: { from: Date; to: Date }): Promise<HandoffRow[]> {
  const out: HandoffRow[] = [];
  for (const c of await clinicsFor(db, {})) {
    const rows = await withClinic(db, c.id, (tx) => tx.select().from(handoffs).where(and(
      eq(handoffs.clinicId, c.id), eq(handoffs.verdict, 'not_needed'), gte(handoffs.reviewedAt, f.from), lt(handoffs.reviewedAt, f.to),
    )).orderBy(desc(handoffs.reviewedAt)));
    out.push(...rows.map((r) => rowOf(r, c)));
  }
  return out.sort((a, b) => (b.reviewedAt ?? '').localeCompare(a.reviewedAt ?? ''));
}
