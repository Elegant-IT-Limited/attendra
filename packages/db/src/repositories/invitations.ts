// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { authUsers, invitations, memberships } from '../auth-schema';
import type { Database, Tx } from '../client';
import { auditLogs, clinics } from '../schema';
import type { StaffRole } from './front-desk';

/** How long an invitation waits for an answer. */
export const INVITATION_DAYS = 7;

export type InvitationResult = 'done' | 'not_found' | 'already_member' | 'owner_grant' | 'owner_protected';

const normalise = (email: string) => email.trim().toLowerCase();

/**
 * Invites an email to an organization's team, from one of its clinics, with its audit
 * rows, in one transaction with the team locked. Only an owner invites an owner. Sending
 * it again to an address still invited renews that invitation (new role, 7 more days).
 * Whether the address has an Attendra account is not this function's question: the
 * caller answers every address the same way.
 */
export async function inviteToTeam(db: Database, orgId: string, clinicId: string, actor: { userId: string; role: StaffRole },
  invite: { email: string; role: StaffRole; approvesRefills?: boolean }, now = new Date()): Promise<{ result: 'done'; id: string; expiresAt: Date; clinicName: string } | { result: Exclude<InvitationResult, 'done'> }> {
  const email = normalise(invite.email);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from memberships where organization_id = ${orgId} for update`);
    if (invite.role === 'owner' && actor.role !== 'owner') return { result: 'owner_grant' as const };
    const [clinic] = await tx.select({ name: clinics.name }).from(clinics).where(and(eq(clinics.id, clinicId), eq(clinics.orgId, orgId)));
    if (!clinic) return { result: 'not_found' as const };
    const [member] = await tx.select({ id: memberships.id }).from(memberships).innerJoin(authUsers, eq(authUsers.id, memberships.userId))
      .where(and(eq(memberships.organizationId, orgId), eq(authUsers.email, email))).limit(1);
    if (member) return { result: 'already_member' as const };
    await lapse(tx, now, sql`organization_id = ${orgId} and email = ${email}`);
    const expiresAt = new Date(now.getTime() + INVITATION_DAYS * 86_400_000);
    const values = { clinicId, role: invite.role, approvesRefills: invite.role !== 'viewer' && !!invite.approvesRefills, inviterId: actor.userId, expiresAt };
    const [open] = await tx.select({ id: invitations.id, role: invitations.role }).from(invitations)
      .where(and(eq(invitations.organizationId, orgId), eq(invitations.email, email), eq(invitations.status, 'pending'))).for('update');
    // a manager does not turn an owner's invitation into another one
    if (open?.role === 'owner' && actor.role !== 'owner') return { result: 'owner_protected' as const };
    const id = open?.id ?? crypto.randomUUID();
    if (open) await tx.update(invitations).set(values).where(eq(invitations.id, id));
    else await tx.insert(invitations).values({ id, organizationId: orgId, email, status: 'pending', createdAt: now, ...values });
    await audit(tx, orgId, `user:${actor.userId}`, `member.invited:${invite.role}`, id, now);
    return { result: 'done' as const, id, expiresAt, clinicName: clinic.name };
  });
}

/** The invitations a team is waiting on, oldest first, with who sent each. Lapsed ones are closed first. */
export async function teamInvitations(db: Database, orgId: string, now = new Date()) {
  await lapseInvitations(db, now);
  const rows = await db.select({
    id: invitations.id, email: invitations.email, role: invitations.role, approvesRefills: invitations.approvesRefills,
    invitedBy: authUsers.name, createdAt: invitations.createdAt, expiresAt: invitations.expiresAt,
  }).from(invitations).innerJoin(authUsers, eq(authUsers.id, invitations.inviterId))
    .where(and(eq(invitations.organizationId, orgId), eq(invitations.status, 'pending'), gt(invitations.expiresAt, now)))
    .orderBy(asc(invitations.createdAt));
  return rows.map((r) => ({ ...r, role: r.role as StaffRole }));
}

/** Cancels one of the team's own open invitations. Only an owner cancels an owner's. Audited. */
export async function cancelInvitation(db: Database, orgId: string, actor: { userId: string; role: StaffRole }, id: string, now = new Date()): Promise<InvitationResult> {
  await lapseInvitations(db, now);
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ role: invitations.role }).from(invitations)
      .where(and(eq(invitations.id, id), eq(invitations.organizationId, orgId), eq(invitations.status, 'pending'))).for('update');
    if (!row) return 'not_found';
    if (row.role === 'owner' && actor.role !== 'owner') return 'owner_protected';
    await tx.update(invitations).set({ status: 'canceled', decidedAt: now }).where(eq(invitations.id, id));
    await audit(tx, orgId, `user:${actor.userId}`, 'member.invite.canceled', id, now);
    return 'done';
  });
}

/** The open invitations for a signed-in person's email, with the clinic each came from. A closed clinic's are left out. */
export async function invitationsFor(db: Database, email: string, now = new Date()) {
  await lapseInvitations(db, now);
  const rows = await db.select({
    id: invitations.id, clinicId: clinics.id, clinicName: clinics.name, role: invitations.role, approvesRefills: invitations.approvesRefills, expiresAt: invitations.expiresAt,
  }).from(invitations).innerJoin(clinics, eq(clinics.id, invitations.clinicId))
    .where(and(eq(invitations.email, normalise(email)), eq(invitations.status, 'pending'), gt(invitations.expiresAt, now), isNull(clinics.closedAt)))
    .orderBy(asc(invitations.createdAt));
  return rows.map((r) => ({ ...r, role: r.role as StaffRole }));
}

/**
 * The invited person accepts or declines. Only an open invitation to their own email, so
 * an id alone does nothing. Accepting adds the membership with the invitation's role;
 * nothing about their password, two-step sign-in or other teams changes. The inviting
 * team's audit log gets the row, written as the person.
 */
export async function answerInvitation(db: Database, person: { userId: string; email: string }, id: string, accept: boolean, now = new Date()): Promise<{ result: 'done'; clinicId: string } | { result: 'not_found' }> {
  await lapseInvitations(db, now);
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(invitations)
      .where(and(eq(invitations.id, id), eq(invitations.email, normalise(person.email)), eq(invitations.status, 'pending'), gt(invitations.expiresAt, now))).for('update');
    if (!row?.clinicId) return { result: 'not_found' as const };
    if (accept) {
      await tx.execute(sql`select id from memberships where organization_id = ${row.organizationId} for update`);
      await tx.insert(memberships).values({ id: crypto.randomUUID(), organizationId: row.organizationId, userId: person.userId, role: row.role as StaffRole, approvesRefills: row.approvesRefills })
        .onConflictDoNothing();
    }
    await tx.update(invitations).set({ status: accept ? 'accepted' : 'declined', decidedAt: now }).where(eq(invitations.id, id));
    await audit(tx, row.organizationId, `user:${person.userId}`, accept ? 'member.invite.accepted' : 'member.invite.declined', id, now);
    return { result: 'done' as const, clinicId: row.clinicId };
  });
}

/** Closes every invitation whose 7 days are over, with an audit row dated when it lapsed. */
export async function lapseInvitations(db: Database, now = new Date()) {
  await db.transaction((tx) => lapse(tx, now));
}

async function lapse(tx: Tx, now: Date, where = sql`true`) {
  const lapsed = (await tx.execute(sql`update invitations set status = 'expired', decided_at = expires_at
    where status = 'pending' and expires_at <= ${now.toISOString()}::timestamptz and ${where}
    returning id, organization_id, expires_at`)).rows as { id: string; organization_id: string; expires_at: string | Date }[];
  for (const l of lapsed) await audit(tx, l.organization_id, 'system', 'member.invite.expired', l.id, new Date(l.expires_at));
}

/** One row in every clinic of the organization, as for every other team change. */
async function audit(tx: Tx, orgId: string, actor: string, action: string, invitationId: string, at: Date) {
  for (const { id } of await tx.select({ id: clinics.id }).from(clinics).where(eq(clinics.orgId, orgId))) {
    await tx.execute(sql`select set_config('app.clinic_id', ${id}, true)`);
    await tx.insert(auditLogs).values({ clinicId: id, actor, action, entity: 'invitation', entityId: invitationId, at });
  }
}

