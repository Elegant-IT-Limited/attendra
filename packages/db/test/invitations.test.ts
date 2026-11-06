import { DEMO_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answerInvitation, cancelInvitation, createPhiCipher, invitationById, invitationsFor, inviteToTeam, saveClinic, seedDemo, teamInvitations } from '../src';
import { openTestDatabase, TEST_DATA_KEY } from '../src/testing';

let t: Awaited<ReturnType<typeof openTestDatabase>>;
const owner = { userId: 'u_owner', role: 'owner' as const };
const manager = { userId: 'u_manager', role: 'admin' as const };
const t0 = new Date('2026-11-06T15:00:00Z');
// a second location of the same business, and a third
const BRANCH = { ...DEMO_CLINIC, id: 'clinic_branch', name: 'Maple Street Branch', phoneNumbers: ['+13035550121'] };
const ANNEX = { ...DEMO_CLINIC, id: 'clinic_annex', name: 'Maple Street Annex', phoneNumbers: ['+13035550122'] };
beforeAll(async () => {
  t = await openTestDatabase();
  await seedDemo(t.db, createPhiCipher(TEST_DATA_KEY));
  await saveClinic(t.db, 'org_demo', BRANCH);
  await saveClinic(t.db, 'org_demo', ANNEX);
  for (const [id, email] of [['u_owner', 'owner@maple.example'], ['u_manager', 'manager@maple.example'], ['u_kim', 'kim@elsewhere.example'], ['u_lee', 'lee@elsewhere.example']] as const) {
    await t.db.execute(sql`insert into auth_users (id, name, email, email_verified) values (${id}, ${id}, ${email}, true)`);
  }
  await t.db.execute(sql`insert into memberships (id, organization_id, user_id, role) values ('m_owner', 'org_demo', 'u_owner', 'owner')`);
  await t.db.execute(sql`insert into clinic_memberships (id, clinic_id, user_id, role) values ('m_manager', ${DEMO_CLINIC.id}, 'u_manager', 'admin')`);
});
afterAll(() => t.close());

const actions = async (id: string, clinicId = DEMO_CLINIC.id) => ((await t.db.execute(sql`select action from audit_logs where entity = 'invitation' and entity_id = ${id} and clinic_id = ${clinicId} order by id`)).rows as { action: string }[]).map((r) => r.action);
const access = async (userId: string) => (await t.db.execute(sql`select clinic_id, role from clinic_access where user_id = ${userId} order by clinic_id`)).rows;

describe('team invitations', () => {
  it('keeps one open invitation per address per location, normalised, and renews it when sent again', async () => {
    const a = await inviteToTeam(t.db, DEMO_CLINIC.id, owner, { email: ' Kim@Elsewhere.example ', role: 'staff' }, t0);
    const b = await inviteToTeam(t.db, DEMO_CLINIC.id, manager, { email: 'kim@elsewhere.example', role: 'viewer', approvesRefills: true }, new Date(t0.getTime() + 60_000));
    expect(a.result === 'done' && b.result === 'done' && a.id === b.id).toBe(true);
    const [row] = await teamInvitations(t.db, DEMO_CLINIC.id, t0);
    // a viewer never approves refills
    expect(row).toMatchObject({ email: 'kim@elsewhere.example', role: 'viewer', approvesRefills: false, invitedBy: 'u_manager', allLocations: false });
    expect(row!.expiresAt.getTime()).toBe(t0.getTime() + 60_000 + 7 * 86_400_000);
    // the other locations are not waiting on it
    expect(await teamInvitations(t.db, BRANCH.id, t0)).toEqual([]);
  });

  it('refuses an owner invitation or "every location" from a manager, someone already here, and an unknown clinic', async () => {
    expect((await inviteToTeam(t.db, DEMO_CLINIC.id, manager, { email: 'new@maple.example', role: 'owner' }, t0)).result).toBe('owner_grant');
    expect((await inviteToTeam(t.db, DEMO_CLINIC.id, manager, { email: 'new@maple.example', role: 'staff', allLocations: true }, t0)).result).toBe('all_locations_owner_only');
    expect((await inviteToTeam(t.db, DEMO_CLINIC.id, owner, { email: 'MANAGER@maple.example', role: 'staff' }, t0)).result).toBe('already_member');
    // an owner already opens every location
    expect((await inviteToTeam(t.db, BRANCH.id, owner, { email: 'owner@maple.example', role: 'staff' }, t0)).result).toBe('already_member');
    expect((await inviteToTeam(t.db, 'clinic_nonexistent', owner, { email: 'x@maple.example', role: 'staff' }, t0)).result).toBe('not_found');
  });

  it('a manager at one location can be invited to another with a different role', async () => {
    const r = await inviteToTeam(t.db, BRANCH.id, owner, { email: 'manager@maple.example', role: 'viewer' }, t0);
    expect(r.result).toBe('done');
    const [inv] = await invitationsFor(t.db, 'manager@maple.example', t0);
    expect(await answerInvitation(t.db, { userId: 'u_manager', email: 'manager@maple.example' }, inv!.id, true, t0)).toEqual({ result: 'done', clinicId: BRANCH.id });
    expect(await access('u_manager')).toEqual([{ clinic_id: BRANCH.id, role: 'viewer' }, { clinic_id: DEMO_CLINIC.id, role: 'admin' }]);
  });

  it('only the invited email answers; accepting opens that location only, once', async () => {
    const [inv] = await invitationsFor(t.db, 'KIM@elsewhere.example', t0);
    expect(inv).toMatchObject({ clinicId: DEMO_CLINIC.id, role: 'viewer', locations: [{ id: DEMO_CLINIC.id, name: DEMO_CLINIC.name }] });
    expect((await answerInvitation(t.db, { userId: 'u_manager', email: 'manager@maple.example' }, inv!.id, true, t0)).result).toBe('not_found');
    expect(await answerInvitation(t.db, { userId: 'u_kim', email: 'kim@elsewhere.example' }, inv!.id, true, t0)).toEqual({ result: 'done', clinicId: DEMO_CLINIC.id });
    expect((await answerInvitation(t.db, { userId: 'u_kim', email: 'kim@elsewhere.example' }, inv!.id, false, t0)).result).toBe('not_found');
    expect(await access('u_kim')).toEqual([{ clinic_id: DEMO_CLINIC.id, role: 'viewer' }]);
    expect(await actions(inv!.id)).toEqual(['member.invited:staff', 'member.invited:viewer', 'member.invite.accepted']);
  });

  it('"every location" sends one invitation per location, answered by one Accept', async () => {
    const r = await inviteToTeam(t.db, DEMO_CLINIC.id, owner, { email: 'lee@elsewhere.example', role: 'staff', allLocations: true }, t0);
    if (r.result !== 'done') throw new Error(r.result);
    expect(r.ids).toHaveLength(3);
    expect(r.locations).toEqual([ANNEX.name, BRANCH.name, DEMO_CLINIC.name]);
    const mine = await invitationsFor(t.db, 'lee@elsewhere.example', t0);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.locations.map((l) => l.id).sort()).toEqual([ANNEX.id, BRANCH.id, DEMO_CLINIC.id].sort());
    expect((await teamInvitations(t.db, BRANCH.id, t0))[0]).toMatchObject({ email: 'lee@elsewhere.example', allLocations: true });
    expect((await answerInvitation(t.db, { userId: 'u_lee', email: 'lee@elsewhere.example' }, r.ids[1]!, true, t0)).result).toBe('done');
    expect(await access('u_lee')).toEqual([ANNEX.id, BRANCH.id, DEMO_CLINIC.id].sort().map((clinic_id) => ({ clinic_id, role: 'staff' })));
    expect(await invitationsFor(t.db, 'lee@elsewhere.example', t0)).toEqual([]);
  });

  it('an owner invitation opens the whole business on accept', async () => {
    await t.db.execute(sql`insert into auth_users (id, name, email, email_verified) values ('u_olga', 'u_olga', 'olga@maple.example', true)`);
    const r = await inviteToTeam(t.db, BRANCH.id, owner, { email: 'olga@maple.example', role: 'owner' }, t0);
    if (r.result !== 'done') throw new Error(r.result);
    expect(await invitationById(t.db, { email: 'olga@maple.example' }, r.id, t0)).toMatchObject({ state: 'pending', role: 'owner', allLocations: true, clinicName: BRANCH.name });
    await answerInvitation(t.db, { userId: 'u_olga', email: 'olga@maple.example' }, r.id, true, t0);
    expect((await access('u_olga')).map((a: unknown) => (a as { role: string }).role)).toEqual(['owner', 'owner', 'owner']);
  });

  it('the invitation link: its own state for the invited address, nothing about it for anyone else', async () => {
    const r = await inviteToTeam(t.db, ANNEX.id, owner, { email: 'pat@elsewhere.example', role: 'staff' }, t0);
    if (r.result !== 'done') throw new Error(r.result);
    expect(await invitationById(t.db, { email: 'PAT@elsewhere.example' }, r.id, t0)).toMatchObject({ state: 'pending', clinicId: ANNEX.id, clinicName: ANNEX.name, role: 'staff' });
    expect(await invitationById(t.db, { email: 'kim@elsewhere.example' }, r.id, t0)).toEqual({ state: 'other_address' });
    expect(await invitationById(t.db, { email: 'kim@elsewhere.example' }, 'no-such-id', t0)).toEqual({ state: 'not_found' });
    expect((await invitationById(t.db, { email: 'pat@elsewhere.example' }, r.id, new Date(t0.getTime() + 8 * 86_400_000))).state).toBe('expired');
    expect(await cancelInvitation(t.db, ANNEX.id, owner, r.id, t0)).toBe('done');
    expect((await invitationById(t.db, { email: 'pat@elsewhere.example' }, r.id, t0)).state).toBe('canceled');
  });

  it('a manager does not cancel an owner\'s invitation; another location cannot cancel it; a lapsed one cannot be cancelled', async () => {
    const o = await inviteToTeam(t.db, DEMO_CLINIC.id, owner, { email: 'olive@maple.example', role: 'owner' }, t0);
    if (o.result !== 'done') throw new Error(o.result);
    expect(await cancelInvitation(t.db, DEMO_CLINIC.id, manager, o.id, t0)).toBe('owner_protected');
    expect(await cancelInvitation(t.db, BRANCH.id, owner, o.id, t0)).toBe('not_found');
    expect(await cancelInvitation(t.db, DEMO_CLINIC.id, owner, o.id, new Date(t0.getTime() + 8 * 86_400_000))).toBe('not_found');
    expect(await actions(o.id)).toEqual(['member.invited:owner', 'member.invite.expired']);
  });

  it('the table takes only known roles and states', async () => {
    await expect(t.db.execute(sql`update invitations set status = 'maybe'`)).rejects.toThrow();
    await expect(t.db.execute(sql`update invitations set role = 'boss'`)).rejects.toThrow();
  });
});
