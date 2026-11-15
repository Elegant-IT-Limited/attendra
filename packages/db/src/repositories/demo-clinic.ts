// SPDX-License-Identifier: AGPL-3.0-only
import { ClinicConfig, DEMO_LIMIT_CODES, DEMO_LIMITS, type DemoLimitCode, type DemoUsage } from '@attendra/core';
import { eq, sql } from 'drizzle-orm';
import { type Database, setClinicScope, withClinic } from '../client';
import { type PhiCipher, phiContext } from '../crypto';
import { auditLogs, clinics, demoBaselines } from '../schema';
import { callerKey } from './calls';

/**
 * A demo clinic's data (2026-11-16, core demo-clinic.ts): today's use of its line for the limits, the baseline the
 * owner sets once the demo data is loaded, and the reset that puts it back. Every query names the clinic and runs with
 * the clinic set for row-level security, so no other clinic's row is read or touched; and every one refuses a clinic
 * that is not a demo clinic.
 */

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Row = Record<string, unknown>;

/** Today's use, and the refusals already made today for each limit (so a limit's Slack line goes out once a day). */
export type DemoUsageToday = DemoUsage & { refusedToday: Record<DemoLimitCode, number> };

/** The tool name a turned-away call's record keeps, with the limit's code in its result. */
export const DEMO_LIMIT_TOOL = 'demo_limit';

/**
 * The demo line's use in [start, end) (the clinic's day): the answered phone calls from this number (by its keyed hash;
 * never the number), the seconds of every phone call to the clinic (a call still going counts what it has run so far,
 * and no call counts more than a demo call may last), and the refusals already made. Browser test calls are staff's and
 * are not counted.
 */
export async function demoUsage(db: Database, cipher: PhiCipher, clinicId: string, from: string | null, day: { start: Date; end: Date }, now: Date): Promise<DemoUsageToday> {
  return withClinic(db, clinicId, async (tx) => {
    const [row] = (await tx.execute(sql`
      select coalesce(sum(least(extract(epoch from (coalesce(ended_at, ${now}) - started_at)), ${DEMO_LIMITS.callSeconds})), 0)::int as seconds
      from calls where clinic_id = ${clinicId} and channel = 'phone' and started_at >= ${day.start} and started_at < ${day.end}`)).rows as [{ seconds: number }];
    let callerCalls = 0;
    if (from) {
      const [c] = (await tx.execute(sql`
        select count(*)::int as n from calls
        where clinic_id = ${clinicId} and channel = 'phone' and started_at >= ${day.start} and started_at < ${day.end}
          and from_hash = ${cipher.hash(callerKey(clinicId, from))}
          and not exists (select 1 from call_actions a where a.clinic_id = ${clinicId} and a.call_id = calls.id and a.tool = ${DEMO_LIMIT_TOOL})`)).rows as [{ n: number }];
      callerCalls = Number(c.n);
    }
    const refused = (await tx.execute(sql`
      select a.result->>'code' as code, count(*)::int as n from call_actions a
      where a.clinic_id = ${clinicId} and a.tool = ${DEMO_LIMIT_TOOL} and a.created_at >= ${day.start} and a.created_at < ${day.end}
      group by 1`)).rows as { code: string; n: number }[];
    const refusedToday = Object.fromEntries(DEMO_LIMIT_CODES.map((code) => [code, Number(refused.find((r) => r.code === code)?.n ?? 0)])) as Record<DemoLimitCode, number>;
    return { callerCalls, clinicSeconds: Number(row.seconds), refusedToday };
  });
}

/**
 * The tables a baseline holds, in the order they are put back (a row is put back after what it points at), with the
 * columns that identify a row and those the database derives itself (never written back).
 */
const BASELINE_TABLES = [
  { table: 'patients', key: ['id'], derived: [] },
  { table: 'patient_search_keys', key: ['clinic_id', 'key', 'patient_id'], derived: [] },
  { table: 'appointments', key: ['id'], derived: ['blocks_until'] },
  { table: 'tasks', key: ['id'], derived: [] },
  { table: 'task_notes', key: ['id'], derived: [] },
] as const;
type BaselineTable = (typeof BASELINE_TABLES)[number]['table'];
/** A row's links to a call, which the reset clears when the call itself is gone (the clinic's retention removed it). */
const CALL_LINKS: Partial<Record<BaselineTable, string[]>> = { patients: ['created_by_call_id'], appointments: ['created_by_call_id', 'cancelled_by_call_id'], tasks: ['call_id'] };

/** The snapshot as it is kept (encrypted): each table's columns then and its rows, as the database's own JSON of them. */
interface Snapshot { version: 1; takenAt: string; tables: Record<BaselineTable, { columns: string[]; rows: Row[] }> }

const BASELINE_CONTEXT = (clinicId: string) => phiContext(clinicId, 'demo_baselines.data_enc');
const keyOf = (r: Row, key: readonly string[]) => key.map((k) => String(r[k])).join('|');

export type DemoError = 'not_found' | 'not_demo' | 'no_baseline' | 'call_in_progress';
export type BaselineCounts = Record<BaselineTable, number>;
/** What a reset changed in each table: rows added since the baseline (removed), changed (put back), gone (put back). */
export type ResetCounts = Record<BaselineTable, { added: number; changed: number; missing: number }> & { callsUnlinked: number };

/** The clinic, locked for this transaction, when it is a demo clinic: so a switch, a baseline and a reset never cross. */
async function demoClinicFor(tx: Tx, clinicId: string): Promise<{ config: ClinicConfig } | DemoError> {
  const [c] = await tx.select({ config: clinics.config }).from(clinics).where(eq(clinics.id, clinicId)).for('update');
  if (!c) return 'not_found';
  const config = ClinicConfig.parse(c.config);
  if (!config.demoClinic?.enabled) return 'not_demo';
  await setClinicScope(tx, clinicId);
  return { config };
}

async function columnsOf(tx: Tx, table: string): Promise<string[]> {
  const rows = (await tx.execute(sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = ${table} order by ordinal_position`)).rows as { column_name: string }[];
  return rows.map((r) => r.column_name);
}

async function rowsOf(tx: Tx, table: string, clinicId: string): Promise<Row[]> {
  const rows = (await tx.execute(sql`select to_jsonb(t) as r from ${sql.identifier(table)} t where t.clinic_id = ${clinicId}`)).rows as { r: Row | string }[];
  return rows.map((x) => (typeof x.r === 'string' ? JSON.parse(x.r) as Row : x.r));
}

/** A call still going (started in the last two demo calls' length, never ended): a reset waits for it. */
async function callGoing(tx: Tx, clinicId: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - 2 * DEMO_LIMITS.callSeconds * 1000);
  return (await tx.execute(sql`select 1 from calls where clinic_id = ${clinicId} and ended_at is null and started_at > ${since} limit 1`)).rows.length > 0;
}

/** Who did a demo change, as the audit log keeps it: the back office's operator by email, or the nightly run. */
export const demoActor = (email: string) => `backoffice:${email}`;
export const DEMO_NIGHTLY_ACTOR = 'worker:demo-nightly';

/**
 * Demo mode on or off, from the back office (the hosting layer decides who may: an internal test clinic only, never one
 * with a paying plan). Audited with who asked. The baseline is kept when it goes off, for when it comes back on.
 */
export async function setDemoSwitch(db: Database, clinicId: string, enabled: boolean, actor: string, now: Date): Promise<'not_found' | 'changed' | 'unchanged'> {
  return db.transaction(async (tx) => {
    const [c] = await tx.select({ config: clinics.config }).from(clinics).where(eq(clinics.id, clinicId)).for('update');
    if (!c) return 'not_found';
    const config = ClinicConfig.parse(c.config);
    if ((config.demoClinic?.enabled ?? false) === enabled) return 'unchanged';
    const next = { ...config, demoClinic: { enabled, baselineAt: config.demoClinic?.baselineAt ?? null } };
    await tx.update(clinics).set({ config: next, configVersion: sql`${clinics.configVersion} + 1`, configUpdatedAt: now, configUpdatedBy: actor }).where(eq(clinics.id, clinicId));
    await setClinicScope(tx, clinicId);
    await tx.insert(auditLogs).values({ clinicId, actor, action: `clinic.demo.${enabled ? 'on' : 'off'}`, entity: 'clinic', entityId: clinicId });
    return 'changed';
  });
}

/**
 * "Set demo baseline now": the clinic's pets with their owners, their search keys, visits, requests and request notes,
 * as they are, kept encrypted; the clinic's demo setting records when. Replaces an earlier baseline. Audited with who.
 */
export async function setDemoBaseline(db: Database, cipher: PhiCipher, clinicId: string, actor: string, now: Date): Promise<{ ok: true; takenAt: string; counts: BaselineCounts } | { ok: false; error: DemoError }> {
  return db.transaction(async (tx) => {
    const c = await demoClinicFor(tx, clinicId);
    if (typeof c === 'string') return { ok: false, error: c };
    const tables = {} as Snapshot['tables'];
    const counts = {} as BaselineCounts;
    for (const { table } of BASELINE_TABLES) {
      const rows = await rowsOf(tx, table, clinicId);
      tables[table] = { columns: await columnsOf(tx, table), rows };
      counts[table] = rows.length;
    }
    const takenAt = now.toISOString();
    const snapshot: Snapshot = { version: 1, takenAt, tables };
    const dataEnc = cipher.encrypt(JSON.stringify(snapshot), BASELINE_CONTEXT(clinicId));
    await tx.insert(demoBaselines).values({ clinicId, takenAt: now, takenBy: actor, dataEnc, counts, lastResetAt: null, lastResetCounts: null })
      .onConflictDoUpdate({ target: demoBaselines.clinicId, set: { takenAt: now, takenBy: actor, dataEnc, counts, lastResetAt: null, lastResetCounts: null } });
    const config = { ...c.config, demoClinic: { enabled: true, baselineAt: takenAt } };
    await tx.update(clinics).set({ config, configVersion: sql`${clinics.configVersion} + 1`, configUpdatedAt: now, configUpdatedBy: actor }).where(eq(clinics.id, clinicId));
    await tx.insert(auditLogs).values({ clinicId, actor, action: 'demo.baseline_set', entity: 'clinic', entityId: clinicId, counts });
    return { ok: true, takenAt, counts };
  });
}

/**
 * Puts the demo clinic's data back to its baseline, exactly: rows added since go, rows changed or removed since come
 * back as they were. Calls, transcripts, texts, settings, vets, visit types, common questions and documents are never
 * touched; a kept call that pointed at a pet added since keeps no link to it. One transaction, held to this clinic by
 * row-level security and by its own `clinic_id` filters. Refused while a call is going (the nightly run tries again
 * later). `dryRun` counts and changes nothing.
 */
export async function resetDemoClinic(db: Database, cipher: PhiCipher, clinicId: string, actor: string, now: Date, opts: { dryRun?: boolean } = {}): Promise<{ ok: true; counts: ResetCounts; baselineAt: string } | { ok: false; error: DemoError }> {
  let result: { ok: true; counts: ResetCounts; baselineAt: string } | { ok: false; error: DemoError } = { ok: false, error: 'not_found' };
  try {
    await db.transaction(async (tx) => {
      const c = await demoClinicFor(tx, clinicId);
      if (typeof c === 'string') { result = { ok: false, error: c }; return; }
      const [b] = await tx.select().from(demoBaselines).where(eq(demoBaselines.clinicId, clinicId));
      if (!b) { result = { ok: false, error: 'no_baseline' }; return; }
      if (await callGoing(tx, clinicId, now)) { result = { ok: false, error: 'call_in_progress' }; return; }
      const snapshot = JSON.parse(cipher.decrypt(b.dataEnc, BASELINE_CONTEXT(clinicId))) as Snapshot;

      // what is there now against the baseline, per table, by each row's key
      const counts = { callsUnlinked: 0 } as ResetCounts;
      for (const { table, key } of BASELINE_TABLES) {
        const base = new Map(snapshot.tables[table].rows.map((r) => [keyOf(r, key), JSON.stringify(r)]));
        const current = await rowsOf(tx, table, clinicId);
        const seen = new Set<string>();
        let added = 0; let changed = 0;
        for (const r of current) {
          const k = keyOf(r, key);
          seen.add(k);
          const was = base.get(k);
          if (was === undefined) added++;
          else if (was !== JSON.stringify(r)) changed++;
        }
        counts[table] = { added, changed, missing: [...base.keys()].filter((k) => !seen.has(k)).length };
      }

      // a call the retention purge removed since: the rows that named it keep no link to it
      const callIds = [...new Set(Object.entries(CALL_LINKS).flatMap(([t, cols]) => snapshot.tables[t as BaselineTable].rows.flatMap((r) => cols.map((col) => r[col])).filter((v): v is string => typeof v === 'string')))];
      const live = new Set(callIds.length ? ((await tx.execute(sql`
        select c.id::text as id from calls c where c.clinic_id = ${clinicId} and c.id::text in (select jsonb_array_elements_text(${JSON.stringify(callIds)}::jsonb))`)).rows as { id: string }[]).map((r) => r.id) : []);
      for (const [t, cols] of Object.entries(CALL_LINKS)) {
        for (const r of snapshot.tables[t as BaselineTable].rows) for (const col of cols) if (typeof r[col] === 'string' && !live.has(r[col] as string)) r[col] = null;
      }

      const basePets = JSON.stringify(snapshot.tables.patients.rows.map((r) => r.id));
      // kept calls let go of pets added since, which go below; a pet of the baseline stays linked
      counts.callsUnlinked = Number(((await tx.execute(sql`
        with gone as (update calls set patient_id = null where clinic_id = ${clinicId} and patient_id is not null
          and patient_id::text not in (select jsonb_array_elements_text(${basePets}::jsonb)) returning 1)
        select count(*)::int as n from gone`)).rows as [{ n: number }])[0].n);
      // everything that points at a pet goes first, then the pets added since; the baseline's pets are written back in place
      // (a kept call may point at one of them)
      for (const table of ['task_notes', 'tasks', 'appointments', 'patient_search_keys'] as const) {
        await tx.execute(sql`delete from ${sql.identifier(table)} where clinic_id = ${clinicId}`);
      }
      await tx.execute(sql`delete from patients where clinic_id = ${clinicId} and id::text not in (select jsonb_array_elements_text(${basePets}::jsonb))`);
      for (const { table, derived } of BASELINE_TABLES) {
        const { rows, columns } = snapshot.tables[table];
        if (!rows.length) continue;
        // the columns the baseline had that the table still has; a column added since takes its default
        const still = new Set(await columnsOf(tx, table));
        const cols = columns.filter((col) => still.has(col) && !(derived as readonly string[]).includes(col));
        const list = sql.join(cols.map((col) => sql.identifier(col)), sql`, `);
        const values = sql`select ${list} from jsonb_populate_recordset(null::${sql.identifier(table)}, ${JSON.stringify(rows)}::jsonb) where clinic_id = ${clinicId}`;
        if (table === 'patients') {
          const set = sql.join(cols.filter((col) => col !== 'id').map((col) => sql`${sql.identifier(col)} = excluded.${sql.identifier(col)}`), sql`, `);
          await tx.execute(sql`insert into patients (${list}) ${values} on conflict (id) do update set ${set} where patients.clinic_id = ${clinicId}`);
        } else {
          await tx.execute(sql`insert into ${sql.identifier(table)} (${list}) ${values}`);
        }
      }
      const flat: Record<string, number> = { calls_unlinked: counts.callsUnlinked };
      for (const { table } of BASELINE_TABLES) for (const [k, v] of Object.entries(counts[table])) flat[`${table}_${k}`] = v;
      await tx.update(demoBaselines).set({ lastResetAt: now, lastResetCounts: counts }).where(eq(demoBaselines.clinicId, clinicId));
      await tx.insert(auditLogs).values({ clinicId, actor, action: 'demo.reset', entity: 'clinic', entityId: clinicId, counts: flat });
      result = { ok: true, counts, baselineAt: snapshot.takenAt };
      if (opts.dryRun) throw new DryRun();
    });
  } catch (err) {
    if (!(err instanceof DryRun)) throw err;
  }
  return result;
}
class DryRun extends Error {}

/** A demo reset's counts in one line for Slack: what callers added was removed, what they changed or removed was put back. Numbers only. */
export function demoResetLine(c: ResetCounts): string {
  const sum = (k: 'added' | 'changed' | 'missing') => (['patients', 'appointments', 'tasks', 'task_notes'] as const).map((t) => `${t.replace('task_notes', 'notes').replace('tasks', 'requests').replace('patients', 'pets').replace('appointments', 'visits')} ${c[t][k]}`).join(', ');
  return `removed (added since the baseline): ${sum('added')}; put back (changed): ${sum('changed')}; put back (removed): ${sum('missing')}; calls unlinked from removed pets: ${c.callsUnlinked}`;
}

/** A demo clinic's state for the back office: on or off, its baseline (when, by whom, how many rows) and its last reset. */
export async function demoState(db: Database, clinicId: string): Promise<{
  enabled: boolean; baselineAt: string | null; baselineBy: string | null; baselineCounts: BaselineCounts | null; lastResetAt: string | null; lastResetCounts: ResetCounts | null;
} | null> {
  const [c] = await db.select({ config: clinics.config }).from(clinics).where(eq(clinics.id, clinicId));
  if (!c) return null;
  const demo = ClinicConfig.parse(c.config).demoClinic;
  const [b] = await withClinic(db, clinicId, (tx) => tx.select({ takenAt: demoBaselines.takenAt, takenBy: demoBaselines.takenBy, counts: demoBaselines.counts, lastResetAt: demoBaselines.lastResetAt, lastResetCounts: demoBaselines.lastResetCounts })
    .from(demoBaselines).where(eq(demoBaselines.clinicId, clinicId)));
  return {
    enabled: demo?.enabled ?? false,
    baselineAt: b?.takenAt.toISOString() ?? null, baselineBy: b?.takenBy ?? null, baselineCounts: (b?.counts as BaselineCounts | undefined) ?? null,
    lastResetAt: b?.lastResetAt?.toISOString() ?? null, lastResetCounts: (b?.lastResetCounts as ResetCounts | null | undefined) ?? null,
  };
}

/** The demo clinics (open ones only) and when each was last reset, for the nightly run. */
export async function demoClinics(db: Database): Promise<{ clinicId: string; timezone: string; lastResetAt: Date | null; hasBaseline: boolean }[]> {
  const rows = await db.select({ id: clinics.id, timezone: clinics.timezone }).from(clinics)
    .where(sql`${clinics.closedAt} is null and ${clinics.config}->'demoClinic'->>'enabled' = 'true'`);
  const out = [];
  for (const r of rows) {
    const [b] = await withClinic(db, r.id, (tx) => tx.select({ lastResetAt: demoBaselines.lastResetAt, takenAt: demoBaselines.takenAt }).from(demoBaselines).where(eq(demoBaselines.clinicId, r.id)));
    out.push({ clinicId: r.id, timezone: r.timezone, lastResetAt: b ? (b.lastResetAt ?? b.takenAt) : null, hasBaseline: !!b });
  }
  return out;
}
