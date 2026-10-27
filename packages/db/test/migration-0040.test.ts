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

describe('migration 0040', () => {
  it('fills in who added each request by hand from its audit row, in its own clinic, and leaves the assistant\'s alone', async () => {
    // a database migrated up to 0039, with requests already in two clinics' queues
    const before = mkdtempSync(join(tmpdir(), 'attendra-0039-'));
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && f < '0040')) copyFileSync(join(MIGRATIONS_DIR, f), join(before, f));
    const client = new PGlite({ extensions: { btree_gist, vector } });
    await migrate(client, before);
    const db = drizzle(client, { schema }) as unknown as Database;
    await saveClinic(db, 'org_demo', DEMO_CLINIC);
    await saveClinic(db, 'org_other', { ...DEMO_CLINIC, id: 'clinic_other', name: 'Other', phoneNumbers: ['+13035550120'] });
    const task = async (clinicId: string, key: string, actor: string, callId: string | null = null) => {
      const [{ id }] = (await db.execute(sql`insert into tasks (clinic_id, type, call_id, details_enc, idempotency_key) values (${clinicId}, 'callback', ${callId}, 'x', ${key}) returning id`)).rows as [{ id: string }];
      await db.execute(sql`insert into audit_logs (clinic_id, actor, action, entity, entity_id) values (${clinicId}, ${actor}, 'task.created.callback', 'task', ${id})`);
      return id;
    };
    const [{ id: call }] = (await db.execute(sql`insert into calls (clinic_id, openai_session_id) values (${DEMO_CLINIC.id}, 'sess_0040') returning id`)).rows as [{ id: string }];
    const byHand = await task(DEMO_CLINIC.id, 'manual:1', 'user:user_ana');
    const elsewhere = await task('clinic_other', 'manual:2', 'user:user_otto');
    const fromCall = await task(DEMO_CLINIC.id, 'call:1', 'voice-agent', call);
    const byWorker = await task(DEMO_CLINIC.id, 'worker:1', 'worker');

    await expect(migrate(client)).resolves.toEqual(readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && f >= '0040').sort());
    const rows = (await db.execute(sql`select id, created_by_user_id from tasks`)).rows as { id: string; created_by_user_id: string | null }[];
    expect(Object.fromEntries(rows.map((r) => [r.id, r.created_by_user_id]))).toEqual({ [byHand]: 'user_ana', [elsewhere]: 'user_otto', [fromCall]: null, [byWorker]: null });
    await client.close();
  }, 60_000);
});
