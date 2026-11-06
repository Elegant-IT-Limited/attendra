import { DEMO_CLINIC } from '@attendra/core';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { vector } from '@electric-sql/pglite-pgvector';
import { sql } from 'drizzle-orm';
import { mkdtempSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changeTeam, clinicsForUser, createPhiCipher, listMembers, migrate, MIGRATIONS_DIR, requestAssignees, saveClinic, seedDemo, staffRole } from '../src';
import { openTestDatabase, TEST_DATA_KEY } from '../src/testing';

/** Access per location (migration 0046): made-up people at a made-up business with two locations. */
describe('migration 0046: nobody loses access', () => {
  it('copies every non-owner to every location of their business, keeps owners account-wide, and keeps the old rows aside', async () => {
    // the migrations before 0046 only, then today's data, then 0046
    const before = mkdtempSync(join(tmpdir(), 'attendra-0046-'));
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && f < '0046')) symlinkSync(join(MIGRATIONS_DIR, f), join(before, f));
    const client = new PGlite({ extensions: { btree_gist, vector } });
    await migrate(client, before);
    await client.exec(`
      insert into organizations (id, name, slug) values ('org_a', 'Alder Vets', 'org_a'), ('org_b', 'Birch Vets', 'org_b');
      insert into clinics (id, org_id, name, timezone, config) values
        ('c_a1', 'org_a', 'Alder North', 'America/New_York', '{}'), ('c_a2', 'org_a', 'Alder South', 'America/New_York', '{}'),
        ('c_a3', 'org_a', 'Alder Old', 'America/New_York', '{}'), ('c_b1', 'org_b', 'Birch', 'America/New_York', '{}');
      update clinics set closed_at = now() where id = 'c_a3';
      insert into auth_users (id, name, email) values ('u_o', 'Oona', 'o@example.com'), ('u_s', 'Sam', 's@example.com'), ('u_v', 'Vic', 'v@example.com');
      insert into memberships (id, organization_id, user_id, role, approves_refills, transfer_number) values
        ('m1', 'org_a', 'u_o', 'owner', true, null), ('m2', 'org_a', 'u_s', 'staff', true, '+13035550140'),
        ('m3', 'org_b', 'u_s', 'admin', false, null), ('m4', 'org_b', 'u_v', 'viewer', false, null);
    `);
    await migrate(client);
    const q = async (text: string) => (await client.query(text)).rows;
    expect(await q(`select clinic_id, user_id, role, approves_refills, transfer_number from clinic_memberships order by clinic_id, user_id`)).toEqual([
      { clinic_id: 'c_a1', user_id: 'u_s', role: 'staff', approves_refills: true, transfer_number: '+13035550140' },
      { clinic_id: 'c_a2', user_id: 'u_s', role: 'staff', approves_refills: true, transfer_number: '+13035550140' },
      { clinic_id: 'c_a3', user_id: 'u_s', role: 'staff', approves_refills: true, transfer_number: '+13035550140' },
      { clinic_id: 'c_b1', user_id: 'u_s', role: 'admin', approves_refills: false, transfer_number: null },
      { clinic_id: 'c_b1', user_id: 'u_v', role: 'viewer', approves_refills: false, transfer_number: null },
    ]);
    expect(await q(`select id, role from memberships order by id`)).toEqual([{ id: 'm1', role: 'owner' }]);
    expect(await q(`select id from memberships_before_0046 order by id`)).toEqual([{ id: 'm2' }, { id: 'm3' }, { id: 'm4' }]);
    // every (location, person) pair the old model opened is still open, with the same role
    expect(await q(`select clinic_id, user_id, role from clinic_access order by clinic_id, user_id`)).toEqual([
      { clinic_id: 'c_a1', user_id: 'u_o', role: 'owner' }, { clinic_id: 'c_a1', user_id: 'u_s', role: 'staff' },
      { clinic_id: 'c_a2', user_id: 'u_o', role: 'owner' }, { clinic_id: 'c_a2', user_id: 'u_s', role: 'staff' },
      { clinic_id: 'c_a3', user_id: 'u_o', role: 'owner' }, { clinic_id: 'c_a3', user_id: 'u_s', role: 'staff' },
      { clinic_id: 'c_b1', user_id: 'u_s', role: 'admin' }, { clinic_id: 'c_b1', user_id: 'u_v', role: 'viewer' },
    ]);
    // from here an organization row is an owner's only
    await expect(client.exec(`insert into memberships (id, organization_id, user_id, role) values ('m9', 'org_b', 'u_o', 'staff')`)).rejects.toThrow();
    await client.close();
  }, 180_000);
});

describe('team changes per location', () => {
  let t: Awaited<ReturnType<typeof openTestDatabase>>;
  const BRANCH = { ...DEMO_CLINIC, id: 'clinic_branch', name: 'Maple Street Branch', phoneNumbers: ['+13035550121'] };
  const owner = { userId: 'u_owner', role: 'owner' as const };
  const roleAt = (userId: string, clinicId: string) => staffRole(t.db, userId, clinicId);
  beforeAll(async () => {
    t = await openTestDatabase();
    await seedDemo(t.db, createPhiCipher(TEST_DATA_KEY));
    await saveClinic(t.db, 'org_demo', BRANCH);
    for (const id of ['u_owner', 'u_owner2', 'u_ann', 'u_bo']) await t.db.execute(sql`insert into auth_users (id, name, email, email_verified) values (${id}, ${id}, ${`${id}@example.com`}, true)`);
    await t.db.execute(sql`insert into memberships (id, organization_id, user_id, role) values ('m_o', 'org_demo', 'u_owner', 'owner')`);
    await t.db.execute(sql`insert into clinic_memberships (id, clinic_id, user_id, role) values ('cm1', ${DEMO_CLINIC.id}, 'u_ann', 'admin'), ('cm2', ${BRANCH.id}, 'u_ann', 'staff'), ('cm3', ${DEMO_CLINIC.id}, 'u_bo', 'staff')`);
  });
  afterAll(() => t.close());

  it('a person sees only the locations they belong to, with the role there', async () => {
    expect((await clinicsForUser(t.db, 'u_bo')).map((c) => [c.clinicId, c.role])).toEqual([[DEMO_CLINIC.id, 'staff']]);
    expect(await roleAt('u_bo', BRANCH.id)).toBeNull();
    expect((await clinicsForUser(t.db, 'u_ann')).map((c) => c.role).sort()).toEqual(['admin', 'staff']);
    expect((await clinicsForUser(t.db, 'u_owner')).every((c) => c.role === 'owner' && c.accountWide)).toBe(true);
    expect((await listMembers(t.db, BRANCH.id)).map((m) => [m.userId, m.role, m.allLocations])).toEqual([['u_ann', 'staff', false], ['u_owner', 'owner', true]]);
    expect((await requestAssignees(t.db, BRANCH.id)).map((m) => m.userId)).toEqual(['u_ann', 'u_owner']);
  });

  it('a manager at one location manages that location only', async () => {
    const ann = { userId: 'u_ann', role: 'admin' as const };
    expect(await changeTeam(t.db, DEMO_CLINIC.id, ann, { type: 'role', userId: 'u_bo', role: 'viewer' })).toBe('done');
    expect(await roleAt('u_bo', DEMO_CLINIC.id)).toBe('viewer');
    // u_bo is not at the branch: nothing to change there
    expect(await changeTeam(t.db, BRANCH.id, ann, { type: 'role', userId: 'u_bo', role: 'staff' })).toBe('not_found');
  });

  it('removing someone from one location keeps their other locations', async () => {
    expect(await changeTeam(t.db, BRANCH.id, owner, { type: 'remove', userId: 'u_ann' })).toBe('done');
    expect(await roleAt('u_ann', BRANCH.id)).toBeNull();
    expect(await roleAt('u_ann', DEMO_CLINIC.id)).toBe('admin');
  });

  it('an owner is account-wide: made at one location, owner at all; made something else, keeps that role at all', async () => {
    expect(await changeTeam(t.db, DEMO_CLINIC.id, owner, { type: 'role', userId: 'u_bo', role: 'owner' })).toBe('done');
    expect([await roleAt('u_bo', DEMO_CLINIC.id), await roleAt('u_bo', BRANCH.id)]).toEqual(['owner', 'owner']);
    expect((await t.db.execute(sql`select count(*)::int as n from clinic_memberships where user_id = 'u_bo'`)).rows).toEqual([{ n: 0 }]);
    expect(await changeTeam(t.db, BRANCH.id, owner, { type: 'role', userId: 'u_bo', role: 'staff' })).toBe('done');
    expect([await roleAt('u_bo', DEMO_CLINIC.id), await roleAt('u_bo', BRANCH.id)]).toEqual(['staff', 'staff']);
  });

  it('a manager never touches an owner, and the last owner stays', async () => {
    const ann = { userId: 'u_ann', role: 'admin' as const };
    expect(await changeTeam(t.db, DEMO_CLINIC.id, ann, { type: 'remove', userId: 'u_owner' })).toBe('owner_protected');
    expect(await changeTeam(t.db, DEMO_CLINIC.id, { userId: 'u_owner2', role: 'owner' }, { type: 'remove', userId: 'u_owner' })).toBe('last_owner');
  });

  it('every reader goes through clinic_access: no reader joins memberships on the organization alone', async () => {
    const { readFileSync } = await import('node:fs');
    const dir = new URL('../src/repositories/', import.meta.url);
    for (const f of readdirSync(dir)) {
      const text = readFileSync(new URL(f, dir), 'utf8');
      expect(text, f).not.toMatch(/clinics\.orgId,\s*memberships\.organizationId|c\.org_id\s*=\s*m\.organization_id/);
    }
  });
});
