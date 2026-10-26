import { DEMO_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answerInvitation, cancelInvitation, createPhiCipher, invitationsFor, inviteToTeam, seedDemo, teamInvitations } from '../src';
import { openTestDatabase, TEST_DATA_KEY } from '../src/testing';

let t: Awaited<ReturnType<typeof openTestDatabase>>;
const owner = { userId: 'u_owner', role: 'owner' as const };
const manager = { userId: 'u_manager', role: 'admin' as const };
const t0 = new Date('2026-11-06T15:00:00Z');
beforeAll(async () => {
  t = await openTestDatabase();
  await seedDemo(t.db, createPhiCipher(TEST_DATA_KEY));
  for (const [id, email, role] of [['u_owner', 'owner@maple.example', 'owner'], ['u_manager', 'manager@maple.example', 'admin'], ['u_kim', 'kim@elsewhere.example', null]] as const) {
    await t.db.execute(sql`insert into auth_users (id, name, email, email_verified) values (${id}, ${id}, ${email}, true)`);
    if (role) await t.db.execute(sql`insert into memberships (id, organization_id, user_id, role) values (${`m_${id}`}, 'org_demo', ${id}, ${role})`);
  }
});
afterAll(() => t.close());

const actions = async (id: string) => ((await t.db.execute(sql`select action from audit_logs where entity = 'invitation' and entity_id = ${id} and clinic_id = ${DEMO_CLINIC.id} order by id`)).rows as { action: string }[]).map((r) => r.action);

describe('team invitations', () => {
  it('keeps one open invitation per address, normalised, and renews it when sent again', async () => {
    const a = await inviteToTeam(t.db, 'org_demo', DEMO_CLINIC.id, owner, { email: ' Kim@Elsewhere.example ', role: 'staff' }, t0);
    const b = await inviteToTeam(t.db, 'org_demo', DEMO_CLINIC.id, manager, { email: 'kim@elsewhere.example', role: 'viewer', approvesRefills: true }, new Date(t0.getTime() + 60_000));
    expect(a.result === 'done' && b.result === 'done' && a.id === b.id).toBe(true);
    const [row] = await teamInvitations(t.db, 'org_demo', t0);
    // a viewer never approves refills
    expect(row).toMatchObject({ email: 'kim@elsewhere.example', role: 'viewer', approvesRefills: false, invitedBy: 'u_manager' });
    expect(row!.expiresAt.getTime()).toBe(t0.getTime() + 60_000 + 7 * 86_400_000);
  });

  it('refuses an owner invitation from a manager, someone on the team, and a clinic of another organization', async () => {
    expect((await inviteToTeam(t.db, 'org_demo', DEMO_CLINIC.id, manager, { email: 'new@maple.example', role: 'owner' }, t0)).result).toBe('owner_grant');
    expect((await inviteToTeam(t.db, 'org_demo', DEMO_CLINIC.id, owner, { email: 'MANAGER@maple.example', role: 'staff' }, t0)).result).toBe('already_member');
    expect((await inviteToTeam(t.db, 'org_other_nonexistent', DEMO_CLINIC.id, owner, { email: 'x@maple.example', role: 'staff' }, t0)).result).toBe('not_found');
  });

  it('only the invited email answers; accepting adds the membership once', async () => {
    const [inv] = await invitationsFor(t.db, 'KIM@elsewhere.example', t0);
    expect(inv).toMatchObject({ clinicId: DEMO_CLINIC.id, role: 'viewer' });
    expect((await answerInvitation(t.db, { userId: 'u_manager', email: 'manager@maple.example' }, inv!.id, true, t0)).result).toBe('not_found');
    expect(await answerInvitation(t.db, { userId: 'u_kim', email: 'kim@elsewhere.example' }, inv!.id, true, t0)).toEqual({ result: 'done', clinicId: DEMO_CLINIC.id });
    expect((await answerInvitation(t.db, { userId: 'u_kim', email: 'kim@elsewhere.example' }, inv!.id, false, t0)).result).toBe('not_found');
    expect((await t.db.execute(sql`select role from memberships where user_id = 'u_kim'`)).rows).toEqual([{ role: 'viewer' }]);
    expect(await actions(inv!.id)).toEqual(['member.invited:staff', 'member.invited:viewer', 'member.invite.accepted']);
  });

  it('a manager does not cancel an owner\'s invitation; a lapsed one cannot be cancelled', async () => {
    const o = await inviteToTeam(t.db, 'org_demo', DEMO_CLINIC.id, owner, { email: 'olive@maple.example', role: 'owner' }, t0);
    if (o.result !== 'done') throw new Error(o.result);
    expect(await cancelInvitation(t.db, 'org_demo', manager, o.id, t0)).toBe('owner_protected');
    expect(await cancelInvitation(t.db, 'org_demo', owner, o.id, new Date(t0.getTime() + 8 * 86_400_000))).toBe('not_found');
    expect(await actions(o.id)).toEqual(['member.invited:owner', 'member.invite.expired']);
  });

  it('the table takes only known roles and states', async () => {
    await expect(t.db.execute(sql`update invitations set status = 'maybe'`)).rejects.toThrow();
    await expect(t.db.execute(sql`update invitations set role = 'boss'`)).rejects.toThrow();
  });
});
