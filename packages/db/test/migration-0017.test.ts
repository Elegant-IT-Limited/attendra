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
import { createPhiCipher, type Database, MIGRATIONS_DIR, migrate, saveClinic, schema, seedDemo } from '../src';
import { TEST_DATA_KEY } from '../src/testing';

describe('migration 0017', () => {
  it('stops with a message naming what links across clinics, and changes nothing', async () => {
    // a database migrated up to 0016, holding a request that names another clinic's patient
    const before = mkdtempSync(join(tmpdir(), 'attendra-0016-'));
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && f < '0017')) copyFileSync(join(MIGRATIONS_DIR, f), join(before, f));
    const client = new PGlite({ extensions: { btree_gist, vector } });
    await migrate(client, before);
    const db = drizzle(client, { schema }) as unknown as Database;
    const maria = (await seedDemo(db, createPhiCipher(TEST_DATA_KEY))).patientIds.maria!;
    await saveClinic(db, 'org_other', { ...DEMO_CLINIC, id: 'clinic_other', name: 'Other', phoneNumbers: ['+13035550200'] });
    await db.execute(sql`insert into tasks (clinic_id, type, patient_id, details_enc, idempotency_key) values ('clinic_other', 'callback', ${maria}, 'x', 'cross-1')`);

    await expect(migrate(client)).rejects.toThrow(/migration 0017 found rows that link across clinics[\s\S]*1 requests whose patient is in another clinic/);
    // nothing applied: the old key is still there, the new ones are not
    const applied = (await client.query<{ id: string }>(`select id from schema_migrations where id like '0017%'`)).rows;
    expect(applied).toEqual([]);
    const keys = (await client.query<{ conname: string }>(`select conname from pg_constraint where conname in ('tasks_patient_id_fkey', 'tasks_patient_same_clinic')`)).rows.map((r) => r.conname);
    expect(keys).toEqual(['tasks_patient_id_fkey']);

    // once the row is fixed, it runs
    await db.execute(sql`update tasks set patient_id = null where idempotency_key = 'cross-1'`);
    await expect(migrate(client)).resolves.toContain('0017_same_clinic_links_2.sql');
    await client.close();
  }, 60_000);
});
