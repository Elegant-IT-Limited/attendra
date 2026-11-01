import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { vector } from '@electric-sql/pglite-pgvector';
import { DEMO_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Database, MIGRATIONS_DIR, migrate, saveClinic, schema } from '../src';

describe('migration 0041', () => {
  it('numbers the requests already in each clinic\'s queue in the order they came in, links the ones with a record to its household, and starts each counter after them', async () => {
    const before = mkdtempSync(join(tmpdir(), 'attendra-0040-'));
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && f < '0041')) copyFileSync(join(MIGRATIONS_DIR, f), join(before, f));
    const client = new PGlite({ extensions: { btree_gist, vector } });
    await migrate(client, before);
    const db = drizzle(client, { schema }) as unknown as Database;
    await saveClinic(db, 'org_demo', DEMO_CLINIC);
    await saveClinic(db, 'org_other', { ...DEMO_CLINIC, id: 'clinic_other', name: 'Other', phoneNumbers: ['+13035550120'] });
    const [{ id: pet }] = (await db.execute(sql`insert into patients (clinic_id, lookup_hash, first_name_enc, last_name_enc, dob_enc, phone_enc, phone_hash) values (${DEMO_CLINIC.id}, 'l', 'f', 'l', 'd', 'p', 'household_x') returning id`)).rows as [{ id: string }];
    const task = async (clinicId: string, key: string, at: string, patientId: string | null = null) => {
      const [{ id }] = (await db.execute(sql`insert into tasks (clinic_id, type, patient_id, details_enc, idempotency_key, created_at) values (${clinicId}, 'callback', ${patientId}, 'x', ${key}, ${at}::timestamptz) returning id`)).rows as [{ id: string }];
      return id;
    };
    const second = await task(DEMO_CLINIC.id, 'a', '2026-10-02T10:00:00Z', pet);
    const first = await task(DEMO_CLINIC.id, 'b', '2026-10-01T10:00:00Z');
    const third = await task(DEMO_CLINIC.id, 'c', '2026-10-03T10:00:00Z');
    const elsewhere = await task('clinic_other', 'd', '2026-10-02T10:00:00Z');

    await expect(migrate(client)).resolves.toEqual(readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && f >= '0041').sort());
    const rows = (await db.execute(sql`select id, number, household_hash from tasks`)).rows as { id: string; number: number; household_hash: string | null }[];
    expect(Object.fromEntries(rows.map((r) => [r.id, [r.number, r.household_hash]]))).toEqual({ [first]: [1, null], [second]: [2, 'household_x'], [third]: [3, null], [elsewhere]: [1, null] });
    const counters = (await db.execute(sql`select clinic_id, next_request from clinic_counters order by clinic_id`)).rows;
    expect(counters).toEqual([{ clinic_id: DEMO_CLINIC.id, next_request: 4 }, { clinic_id: 'clinic_other', next_request: 2 }]);
    await client.close();
  }, 60_000);
});
