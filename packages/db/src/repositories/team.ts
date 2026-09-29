// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, sql } from 'drizzle-orm';
import { authAccounts, authSessions, authUsers, memberships } from '../auth-schema';
import type { Database, Tx } from '../client';
import { auditLogs, clinics, tasks } from '../schema';
import type { StaffRole } from './front-desk';

/** How long a temporary password works before it has to be issued again. */
export const TEMPORARY_PASSWORD_HOURS = 72;

/**
 * The people in an organization, with their role and whether two-step sign-in is
 * on. Owner connection: these are auth tables, which the application role cannot
 * read. There is no "last signed in": sessions do not record which organization
 * they were for, so it would show sign-ins at other practices.
 */
export async function listMembers(db: Database, orgId: string) {
  return db.select({
    userId: authUsers.id, name: authUsers.name, email: authUsers.email, role: memberships.role, twoFactorEnabled: authUsers.twoFactorEnabled,
    mustChangePassword: authUsers.mustChangePassword, addedAt: memberships.createdAt,
  }).from(memberships).innerJoin(authUsers, eq(authUsers.id, memberships.userId))
    .where(eq(memberships.organizationId, orgId)).orderBy(authUsers.name);
}

/** Whether a person still has to replace a temporary password, and until when it works. */
export async function passwordState(db: Database, by: { userId: string } | { email: string }) {
  const [row] = await db.select({ id: authUsers.id, mustChange: authUsers.mustChangePassword, expiresAt: authUsers.temporaryPasswordExpiresAt })
    .from(authUsers).where('userId' in by ? eq(authUsers.id, by.userId) : eq(authUsers.email, by.email.trim().toLowerCase()));
  return row ?? null;
}

/** Marks the password just set as temporary: it has to be changed at first sign-in, and it expires. */
export async function markTemporaryPassword(db: Database | Tx, userId: string, now = new Date()) {
  await db.update(authUsers).set({ mustChangePassword: true, temporaryPasswordExpiresAt: new Date(now.getTime() + TEMPORARY_PASSWORD_HOURS * 3_600_000) })
    .where(eq(authUsers.id, userId));
}

export async function clearTemporaryPassword(db: Database, userId: string) {
  await db.update(authUsers).set({ mustChangePassword: false, temporaryPasswordExpiresAt: null }).where(eq(authUsers.id, userId));
}

export type TeamChange =
  | { type: 'add'; userId: string; role: StaffRole; temporary: boolean }
  | { type: 'role'; userId: string; role: StaffRole }
  | { type: 'remove'; userId: string }
  | { type: 'reset'; userId: string; passwordHash: string };

export type TeamResult = 'done' | 'unchanged' | 'not_found' | 'already_member' | 'self' | 'owner_protected' | 'owner_grant' | 'last_owner';

/**
 * One change to an organization's team, with its audit rows, in one transaction.
 *
 * The organization's memberships are locked first (select ... for update), so the
 * checks below and the change see the same team: two managers removing the last
 * two owners at once end with one owner, not none. The rules: nobody changes,
 * removes or resets themselves here; only an owner touches an owner or makes one;
 * the last owner stays. Every clinic of the organization gets the audit row, with
 * the clinic set for its row-level policy before each insert.
 */
export async function changeTeam(db: Database, orgId: string, actor: { userId: string; role: StaffRole }, change: TeamChange, now = new Date()): Promise<TeamResult> {
  return db.transaction(async (tx) => {
    const team = await tx.execute(sql`select user_id, role from memberships where organization_id = ${orgId} for update`);
    const rows = team.rows as { user_id: string; role: StaffRole }[];
    const target = rows.find((r) => r.user_id === change.userId);
    const owners = rows.filter((r) => r.role === 'owner').length;
    const isOwner = actor.role === 'owner';

    if (change.type === 'add') {
      if (target) return 'already_member';
      if (change.role === 'owner' && !isOwner) return 'owner_grant';
      await tx.insert(memberships).values({ id: crypto.randomUUID(), organizationId: orgId, userId: change.userId, role: change.role });
      if (change.temporary) await markTemporaryPassword(tx, change.userId, now);
      await audit(tx, orgId, actor.userId, `member.added:${change.role}`, change.userId);
      return 'done';
    }

    if (!target) return 'not_found';
    if (change.userId === actor.userId) return 'self';
    if (target.role === 'owner' && !isOwner) return 'owner_protected';

    if (change.type === 'role') {
      if (change.role === 'owner' && !isOwner) return 'owner_grant';
      if (change.role === target.role) return 'unchanged';
      if (target.role === 'owner' && owners <= 1) return 'last_owner';
      await tx.update(memberships).set({ role: change.role }).where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, change.userId)));
      await audit(tx, orgId, actor.userId, `member.role.changed:${change.role}`, change.userId);
      return 'done';
    }

    if (change.type === 'reset') {
      await tx.update(authAccounts).set({ password: change.passwordHash, updatedAt: now })
        .where(and(eq(authAccounts.userId, change.userId), eq(authAccounts.providerId, 'credential')));
      await markTemporaryPassword(tx, change.userId, now);
      await tx.delete(authSessions).where(eq(authSessions.userId, change.userId));
      await audit(tx, orgId, actor.userId, 'member.password.reset', change.userId);
      return 'done';
    }

    // remove
    if (target.role === 'owner' && owners <= 1) return 'last_owner';
    await tx.delete(memberships).where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, change.userId)));
    // whatever they held goes back to the queue, in every clinic of the organization
    for (const clinicId of await clinicsOf(tx, orgId)) {
      await tx.execute(sql`select set_config('app.clinic_id', ${clinicId}, true)`);
      const released = await tx.update(tasks).set({ assigneeUserId: null, claimedAt: null })
        .where(and(eq(tasks.clinicId, clinicId), eq(tasks.status, 'open'), eq(tasks.assigneeUserId, change.userId))).returning({ id: tasks.id });
      if (released.length) {
        await tx.insert(auditLogs).values(released.map((t) => ({ clinicId, actor: `user:${actor.userId}`, action: 'task.released.override', entity: 'task', entityId: t.id })));
      }
    }
    // their sessions go only when they belong nowhere else: the guard already rechecks
    // membership on every request, so access here ends at once either way
    const [elsewhere] = await tx.select({ id: memberships.id }).from(memberships).where(eq(memberships.userId, change.userId)).limit(1);
    if (!elsewhere) await tx.delete(authSessions).where(eq(authSessions.userId, change.userId));
    await audit(tx, orgId, actor.userId, 'member.removed', change.userId);
    return 'done';
  });
}

async function clinicsOf(tx: Tx, orgId: string) {
  return (await tx.select({ id: clinics.id }).from(clinics).where(eq(clinics.orgId, orgId))).map((c) => c.id);
}

async function audit(tx: Tx, orgId: string, actorId: string, action: string, memberId: string) {
  for (const clinicId of await clinicsOf(tx, orgId)) {
    await tx.execute(sql`select set_config('app.clinic_id', ${clinicId}, true)`);
    await tx.insert(auditLogs).values({ clinicId, actor: `user:${actorId}`, action, entity: 'member', entityId: memberId });
  }
}

/** For the tests and the CLI: whether someone has any membership at all. */
export async function hasAnyMembership(db: Database, userId: string) {
  const [row] = await db.select({ id: memberships.id }).from(memberships).where(eq(memberships.userId, userId)).limit(1);
  return !!row;
}
