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
import { CallRepository, createPhiCipher, type Database, MIGRATIONS_DIR, migrate, PatientRecords, saveClinic, schema, seedDemo } from '../src';
import { openTestDatabase, TEST_DATA_KEY } from '../src/testing';

const cipher = createPhiCipher(TEST_DATA_KEY);

describe('migration 0043', () => {
  it('adds the last four digits a browser test call was started as: empty on the calls already there, four digits only, never on a phone call', async () => {
    const before = mkdtempSync(join(tmpdir(), 'attendra-0042-'));
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && f < '0043')) copyFileSync(join(MIGRATIONS_DIR, f), join(before, f));
    const client = new PGlite({ extensions: { btree_gist, vector } });
    await migrate(client, before);
    const db = drizzle(client, { schema }) as unknown as Database;
    await saveClinic(db, 'org_demo', DEMO_CLINIC);
    await db.execute(sql`insert into calls (clinic_id, openai_session_id, channel) values (${DEMO_CLINIC.id}, 'sess_old', 'web')`);

    await expect(migrate(client)).resolves.toEqual(readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && f >= '0043').sort());
    expect((await db.execute(sql`select called_as_last4 from calls`)).rows).toEqual([{ called_as_last4: null }]);
    await db.execute(sql`insert into calls (clinic_id, openai_session_id, channel, called_as_last4) values (${DEMO_CLINIC.id}, 'sess_ok', 'web', '0123')`);
    await expect(db.execute(sql`insert into calls (clinic_id, openai_session_id, channel, called_as_last4) values (${DEMO_CLINIC.id}, 'sess_long', 'web', '5550123')`)).rejects.toThrow();
    await expect(db.execute(sql`insert into calls (clinic_id, openai_session_id, channel, called_as_last4) values (${DEMO_CLINIC.id}, 'sess_phone', 'phone', '0123')`)).rejects.toThrow();
    await client.close();
  }, 60_000);
});

describe('"Call as" in the call record and the records', () => {
  it('keeps only the last four digits on a browser test call, with no caller number, audited; a phone call can never have them', async () => {
    const t = await openTestDatabase();
    try {
      await saveClinic(t.db, 'org_demo', DEMO_CLINIC);
      const calls = new CallRepository(t.db, cipher);
      const id = await calls.open(DEMO_CLINIC.id, 'live_web_as', null, 'web', 'user_ana', '0123');
      const [row] = (await t.db.execute(sql`select called_as_last4, from_hash, from_enc, channel from calls where id = ${id}`)).rows;
      expect(row).toEqual({ called_as_last4: '0123', from_hash: null, from_enc: null, channel: 'web' });
      const audit = (await t.db.execute(sql`select actor, action from audit_logs where call_id = ${id} order by id`)).rows;
      expect(audit).toEqual([{ actor: 'user:user_ana', action: 'call.test.started' }, { actor: 'user:user_ana', action: 'call.test.called_as' }]);
      await expect(calls.open(DEMO_CLINIC.id, 'live_sip_as', '+13035550142', 'phone', undefined, '0142')).rejects.toThrow('browser test call');
      await expect(calls.open(DEMO_CLINIC.id, 'live_web_as2', null, 'web', 'user_ana', '303-555-0142')).rejects.toThrow('last four digits');
      // without it, nothing changes
      const plain = await calls.open(DEMO_CLINIC.id, 'live_web_plain', null, 'web', 'user_ana');
      expect((await t.db.execute(sql`select called_as_last4 from calls where id = ${plain}`)).rows).toEqual([{ called_as_last4: null }]);
    } finally {
      await t.close();
    }
  });

  it('lists one number per household by the owner\'s first name and last four digits, never the whole number, and gives the number for a record of this clinic only', async () => {
    const t = await openTestDatabase();
    try {
      const { patientIds } = await seedDemo(t.db, cipher);
      await saveClinic(t.db, 'org_other', { ...DEMO_CLINIC, id: 'clinic_other', name: 'Other', phoneNumbers: ['+13035550120'] });
      const records = new PatientRecords(t.db, cipher);
      const all = await records.callAsNumbers(DEMO_CLINIC.id, '', 'user_ana');
      expect(all.map((n) => n.label).sort()).toEqual(['James · …0163', 'Maria · …0147', 'Sam · …0171', 'Sam · …0172']);
      // Maria's children are on her number: one row, her own record
      expect(all.find((n) => n.label === 'Maria · …0147')!.patientId).toBe(patientIds.maria);
      for (const n of all) expect(n.label).not.toMatch(/\d{5}/);
      // by a child's name, the owner's name or the last digits: the household's row
      // the row found (Lucas) carries the household's number, under the owner's name
      expect(await records.callAsNumbers(DEMO_CLINIC.id, 'Lucas', 'user_ana')).toEqual([{ patientId: patientIds.lucas, label: 'Maria · …0147' }]);
      expect((await records.callAsNumbers(DEMO_CLINIC.id, '0163', 'user_ana')).map((n) => n.label)).toEqual(['James · …0163']);
      expect(await records.callAsNumbers(DEMO_CLINIC.id, 'Nobody', 'user_ana')).toEqual([]);
      // audited like a search: how many, never what was typed
      const searched = (await t.db.execute(sql`select entity_id from audit_logs where action = 'patient.searched' order by id`)).rows as { entity_id: string }[];
      expect(searched.map((r) => r.entity_id)).toEqual(['matches:1', 'matches:1', 'matches:0']);

      expect(await records.phoneOf(DEMO_CLINIC.id, patientIds.lucas!, 'user_ana')).toBe('+13035550147');
      expect(await records.phoneOf('clinic_other', patientIds.lucas!, 'user_otto')).toBeNull();
      expect((await t.db.execute(sql`select actor, entity_id from audit_logs where action = 'patient.phone.called_as'`)).rows).toEqual([{ actor: 'user:user_ana', entity_id: patientIds.lucas }]);
    } finally {
      await t.close();
    }
  });
});
