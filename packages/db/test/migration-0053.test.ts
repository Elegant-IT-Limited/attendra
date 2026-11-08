import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { vector } from '@electric-sql/pglite-pgvector';
import { DEMO_CLINIC, zonedInstant } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPhiCipher, type Database, MIGRATIONS_DIR, migrate, saveClinic, schema, ScheduleRepository, seedDemo, withClinic } from '../src';
import { openTestDatabase, TEST_DATA_KEY } from '../src/testing';

const cipher = createPhiCipher(TEST_DATA_KEY);
const tz = DEMO_CLINIC.timezone;
const at = (time: string, date = '2026-10-06') => zonedInstant(date, time, tz).toISOString();
// the sick visit keeps 10 minutes free after it (cleaning time)
const BUFFERED = { ...DEMO_CLINIC, visitTypes: DEMO_CLINIC.visitTypes.map((v) => (v.id === 'vt_sick' ? { ...v, bufferMinutes: 10 } : v)) };
const PATIENT = '00000000-0000-4000-8000-000000000053';

async function addPatient(db: Database) {
  await db.execute(sql`insert into patients (id, clinic_id, first_name_enc, last_name_enc, dob_enc, lookup_hash, phone_enc, phone_hash) values (${PATIENT}, ${DEMO_CLINIC.id}, 'x', 'x', 'x', 'h', 'x', 'h')`);
}
const insert = (db: Database, key: string, from: string, to: string, extra = sql``) => db.execute(sql`insert into appointments (clinic_id, patient_id, provider_id, visit_type_id, starts_at, ends_at, idempotency_key, created_by_user_id ${extra.queryChunks.length ? sql`, status, updated_at` : sql``})
  values (${DEMO_CLINIC.id}, ${PATIENT}, 'prov_okafor', 'vt_sick', ${from}, ${to}, ${key}, 'u_desk' ${extra})`);
const row = async (db: Database, key: string) => (await db.execute(sql`select blocks_until, cancelled_at, updated_at from appointments where idempotency_key = ${key}`)).rows[0] as { blocks_until: string; cancelled_at: string | null; updated_at: string };
const iso = (v: string | Date | null) => (v === null ? null : new Date(v).toISOString());

describe('migration 0053', () => {
  it('keeps each booked visit\'s buffer from what is already booked, never more than the old rule allowed, and dates the old cancels by their last change', async () => {
    const before = mkdtempSync(join(tmpdir(), 'attendra-0052-'));
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && f < '0053')) copyFileSync(join(MIGRATIONS_DIR, f), join(before, f));
    const client = new PGlite({ extensions: { btree_gist, vector } });
    await migrate(client, before);
    const db = drizzle(client, { schema }) as unknown as Database;
    await saveClinic(db, 'org_demo', BUFFERED);
    await addPatient(db);
    // 9:00 and 9:20 back to back: booked before the buffer was set, so 9:20 sits in 9:00's cleaning time
    await insert(db, 'a', at('09:00'), at('09:20'));
    await insert(db, 'b', at('09:20'), at('09:40'));
    await insert(db, 'c', at('11:00'), at('11:20'));
    await insert(db, 'gone', at('13:00'), at('13:20'), sql`, 'cancelled', ${'2026-10-01T15:00:00.000Z'}`);

    await expect(migrate(client)).resolves.toEqual(readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && f >= '0053').sort());
    // the pair keeps only its own time; the visit alone gets its 10 minutes
    expect(iso((await row(db, 'a')).blocks_until)).toBe(at('09:20'));
    expect(iso((await row(db, 'b')).blocks_until)).toBe(at('09:40'));
    expect(iso((await row(db, 'c')).blocks_until)).toBe(at('11:30'));
    expect(iso((await row(db, 'gone')).cancelled_at)).toBe('2026-10-01T15:00:00.000Z');
    expect(iso((await row(db, 'c')).cancelled_at)).toBeNull();
    // and from now on the buffer holds: 11:25 starts inside 11:00's cleaning time, 11:30 does not
    await expect(insert(db, 'd', at('11:25'), at('11:45'))).rejects.toMatchObject({ cause: { code: '23P01' } });
    await insert(db, 'e', at('11:30'), at('11:50'));
    await client.close();
  }, 60_000);
});

describe('the cancelled history, by when each visit was cancelled (SCH-10)', () => {
  it('orders by cancelled_at, so a later change to a cancelled visit does not move it', async () => {
    const t = await openTestDatabase();
    try {
      const { patientIds } = await seedDemo(t.db, cipher);
      const cancelled = (key: string, time: string, cancelledAt: string, updatedAt: string) => t.owner.execute(sql`insert into appointments (clinic_id, patient_id, provider_id, visit_type_id, starts_at, ends_at, idempotency_key, created_by_user_id, status, cancelled_at, updated_at)
        values (${DEMO_CLINIC.id}, ${patientIds.maria!}, 'prov_okafor', 'vt_sick', ${at(time, '2027-02-10')}, ${at(time.replace(':00', ':20'), '2027-02-10')}, ${key}, 'u_desk', 'cancelled', ${cancelledAt}, ${updatedAt})`);
      // first cancelled first, but changed last (a note added afterwards)
      await cancelled('first', '09:00', '2027-01-05T10:00:00.000Z', '2027-01-09T12:00:00.000Z');
      await cancelled('second', '10:00', '2027-01-06T10:00:00.000Z', '2027-01-06T10:00:00.000Z');
      const schedule = new ScheduleRepository(t.db, cipher);
      const range = { from: new Date(at('00:00', '2027-02-10')), to: new Date(at('23:59', '2027-02-10')), sort: 'cancelled' as const, label: 'test' };
      const newest = await schedule.cancelled(DEMO_CLINIC.id, { ...range, order: 'newest' }, 'u_ana');
      expect(newest.entries.map((e) => [e.startsAt.toISOString(), e.cancelledAt.toISOString()])).toEqual([
        [at('10:00', '2027-02-10'), '2027-01-06T10:00:00.000Z'], [at('09:00', '2027-02-10'), '2027-01-05T10:00:00.000Z'],
      ]);
      const oldest = await schedule.cancelled(DEMO_CLINIC.id, { ...range, order: 'oldest' }, 'u_ana');
      expect(oldest.entries.map((e) => e.cancelledAt.toISOString())).toEqual(['2027-01-05T10:00:00.000Z', '2027-01-06T10:00:00.000Z']);
    } finally {
      await t.close();
    }
  });
});

describe('the buffer after a visit, in the database (SCH-8)', () => {
  it('is worked out on every write from the visit type\'s setting, and a booking inside it is refused whatever the application checked', async () => {
    const t = await openTestDatabase();
    try {
      await seedDemo(t.db, cipher);
      await saveClinic(t.owner, 'org_demo', BUFFERED);
      await addPatient(t.owner);
      const day = '2027-02-09';
      // straight into the table, past every application check, as two desks racing would land
      const book = (key: string, from: string, to: string) => withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.execute(sql`insert into appointments (clinic_id, patient_id, provider_id, visit_type_id, starts_at, ends_at, idempotency_key, created_by_user_id)
        values (${DEMO_CLINIC.id}, ${PATIENT}, 'prov_okafor', 'vt_sick', ${at(from, day)}, ${at(to, day)}, ${key}, 'u_desk')`));
      await book('x1', '10:00', '10:20');
      expect(iso((await row(t.owner, 'x1')).blocks_until)).toBe(at('10:30', day));
      await expect(book('x2', '10:20', '10:40')).rejects.toMatchObject({ cause: { code: '23P01' } });
      await expect(book('x3', '09:40', '10:00')).rejects.toMatchObject({ cause: { code: '23P01' } }); // its own buffer would run into 10:00
      await book('x4', '10:30', '10:50');
      await book('x5', '09:30', '09:50'); // 9:50 + 10 = 10:00: touching, not overlapping
      // a move recomputes it; a cancel frees it and is dated
      await t.owner.execute(sql`update appointments set starts_at = ${at('15:00', day)}, ends_at = ${at('15:20', day)} where idempotency_key = 'x4'`);
      expect(iso((await row(t.owner, 'x4')).blocks_until)).toBe(at('15:30', day));
      await t.owner.execute(sql`update appointments set status = 'cancelled' where idempotency_key = 'x1'`);
      expect((await row(t.owner, 'x1')).cancelled_at).not.toBeNull();
      await book('x6', '10:20', '10:40');
      // a type with no buffer keeps none
      await withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.execute(sql`insert into appointments (clinic_id, patient_id, provider_id, visit_type_id, starts_at, ends_at, idempotency_key, created_by_user_id)
        values (${DEMO_CLINIC.id}, ${PATIENT}, 'prov_okafor', 'vt_annual', ${at('13:00', day)}, ${at('13:40', day)}, 'x7', 'u_desk')`));
      expect(iso((await row(t.owner, 'x7')).blocks_until)).toBe(at('13:40', day));
      // the application never writes it: a value sent is ignored
      await t.owner.execute(sql`update appointments set blocks_until = ends_at + interval '2 hours' where idempotency_key = 'x7'`);
      expect(iso((await row(t.owner, 'x7')).blocks_until)).toBe(at('13:40', day));
      // a buffer changed in Settings later never touches what is booked until the visit itself moves
      const longer: typeof BUFFERED = { ...BUFFERED, visitTypes: BUFFERED.visitTypes.map((v) => (v.id === 'vt_sick' ? { ...v, bufferMinutes: 60 } : v)) };
      await saveClinic(t.owner, 'org_demo', longer);
      await t.owner.execute(sql`update appointments set confirmed_at = now() where idempotency_key = 'x6'`);
      expect(iso((await row(t.owner, 'x6')).blocks_until)).toBe(at('10:50', day));
    } finally {
      await t.close();
    }
  });
});
