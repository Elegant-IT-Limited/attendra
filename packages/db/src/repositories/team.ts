// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, gt, ne, sql } from 'drizzle-orm';
import { authAccounts, authSessions, authTwoFactors, authUsers, authVerifications, memberships, userAvatars } from '../auth-schema';
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
    mustChangePassword: authUsers.mustChangePassword, addedAt: memberships.createdAt, approvesRefills: memberships.approvesRefills, avatarAt: userAvatars.updatedAt,
  }).from(memberships).innerJoin(authUsers, eq(authUsers.id, memberships.userId)).leftJoin(userAvatars, eq(userAvatars.userId, memberships.userId))
    .where(eq(memberships.organizationId, orgId)).orderBy(authUsers.name);
}

/**
 * Who a request can be given to at a clinic: everyone in its organization who works
 * requests (every role but viewer), owners included, by name and whether they approve
 * refills. Owner connection, like listMembers; no email, nothing about their sign-in.
 */
export async function requestAssignees(db: Database, clinicId: string) {
  return db.select({ userId: authUsers.id, name: authUsers.name, approvesRefills: memberships.approvesRefills, avatarAt: userAvatars.updatedAt }).from(memberships)
    .innerJoin(authUsers, eq(authUsers.id, memberships.userId)).leftJoin(userAvatars, eq(userAvatars.userId, memberships.userId))
    .innerJoin(clinics, eq(clinics.orgId, memberships.organizationId))
    .where(and(eq(clinics.id, clinicId), ne(memberships.role, 'viewer'))).orderBy(authUsers.name);
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

/** Whose password a "forgot password" link resets, while it is still valid. */
export async function resetTokenUser(db: Database, token: string, now = new Date()): Promise<string | null> {
  const [row] = await db.select({ userId: authVerifications.value }).from(authVerifications)
    .where(and(eq(authVerifications.identifier, `reset-password:${token}`), gt(authVerifications.expiresAt, now)));
  return row?.userId ?? null;
}

/** Ends every session a person has. */
export async function endSessions(db: Database, userId: string) {
  await db.delete(authSessions).where(eq(authSessions.userId, userId));
}

export async function clearTemporaryPassword(db: Database, userId: string) {
  await db.update(authUsers).set({ mustChangePassword: false, temporaryPasswordExpiresAt: null }).where(eq(authUsers.id, userId));
}

export type TeamChange =
  /** With `passwordHash`, an existing account that belongs to no team any more is added back with a new temporary password. */
  | { type: 'add'; userId: string; role: StaffRole; temporary: boolean; approvesRefills?: boolean; passwordHash?: string }
  | { type: 'role'; userId: string; role: StaffRole }
  | { type: 'refills'; userId: string; approves: boolean }
  | { type: 'remove'; userId: string }
  | { type: 'reset'; userId: string; passwordHash: string }
  /** A lost phone: two-step sign-in is switched off for the person, who sets it up again at the next sign-in. */
  | { type: 'two_factor'; userId: string };

export type TeamResult = 'done' | 'unchanged' | 'not_found' | 'already_member' | 'self' | 'owner_protected' | 'owner_grant' | 'last_owner' | 'other_organizations' | 'account_exists';

/**
 * One change to an organization's team, with its audit rows, in one transaction.
 *
 * The organization's memberships are locked first (select ... for update), so the
 * checks below and the change see the same team: two managers removing the last
 * two owners at once end with one owner, not none. The rules: nobody changes,
 * removes or resets themselves here; only an owner touches an owner or makes one;
 * the last owner stays. Who may approve refills follows the same rules, except that
 * an owner may mark themselves. Every clinic of the organization gets the audit row, with
 * the clinic set for its row-level policy before each insert.
 */
export async function changeTeam(db: Database, orgId: string, actor: { userId: string; role: StaffRole }, change: TeamChange, now = new Date()): Promise<TeamResult> {
  return db.transaction(async (tx) => {
    const team = await tx.execute(sql`select user_id, role, approves_refills from memberships where organization_id = ${orgId} for update`);
    const rows = team.rows as { user_id: string; role: StaffRole; approves_refills: boolean }[];
    const target = rows.find((r) => r.user_id === change.userId);
    const owners = rows.filter((r) => r.role === 'owner').length;
    const isOwner = actor.role === 'owner';

    if (change.type === 'add') {
      if (target) return 'already_member';
      if (change.role === 'owner' && !isOwner) return 'owner_grant';
      if (change.passwordHash) {
        // someone removed earlier, coming back: only when they belong to no other team
        const [elsewhere] = await tx.select({ id: memberships.id }).from(memberships).where(eq(memberships.userId, change.userId)).limit(1);
        if (elsewhere) return 'other_organizations';
        // and only by the practice that removed them: any other would be handed someone's login
        if (!(await removedHere(tx, orgId, change.userId))) return 'account_exists';
        await tx.update(authAccounts).set({ password: change.passwordHash, updatedAt: now })
          .where(and(eq(authAccounts.userId, change.userId), eq(authAccounts.providerId, 'credential')));
        await tx.delete(authSessions).where(eq(authSessions.userId, change.userId));
      }
      await tx.insert(memberships).values({ id: crypto.randomUUID(), organizationId: orgId, userId: change.userId, role: change.role, approvesRefills: !!change.approvesRefills });
      if (change.temporary) await markTemporaryPassword(tx, change.userId, now);
      await audit(tx, orgId, actor.userId, `member.added:${change.role}`, change.userId);
      if (change.approvesRefills) await audit(tx, orgId, actor.userId, 'member.refill_approval.on', change.userId);
      return 'done';
    }

    if (!target) return 'not_found';
    if (change.type === 'refills') {
      if (change.userId === actor.userId && !isOwner) return 'self';
      if (target.role === 'owner' && !isOwner) return 'owner_protected';
      if (target.approves_refills === change.approves) return 'unchanged';
      await tx.update(memberships).set({ approvesRefills: change.approves }).where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, change.userId)));
      await audit(tx, orgId, actor.userId, `member.refill_approval.${change.approves ? 'on' : 'off'}`, change.userId);
      return 'done';
    }
    if (change.userId === actor.userId) return 'self';
    if (target.role === 'owner' && !isOwner) return 'owner_protected';

    if (change.type === 'role') {
      if (change.role === 'owner' && !isOwner) return 'owner_grant';
      if (change.role === target.role) return 'unchanged';
      if (target.role === 'owner' && owners <= 1) return 'last_owner';
      await tx.update(memberships).set({ role: change.role }).where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, change.userId)));
      await audit(tx, orgId, actor.userId, `member.role.changed:${change.role}`, change.userId);
      if (change.role !== 'owner' && change.role !== 'admin') await revokeKeysOf(tx, orgId, actor.userId, change.userId);
      return 'done';
    }

    if (change.type === 'reset' || change.type === 'two_factor') {
      // a password and a phone belong to the person, not to this team: one who also works for
      // another organization would be signed out there and locked out by a manager here
      const [elsewhere] = await tx.select({ n: sql<number>`count(*)::int` }).from(memberships)
        .where(and(eq(memberships.userId, change.userId), ne(memberships.organizationId, orgId)));
      if (elsewhere && elsewhere.n > 0) return 'other_organizations';
    }
    if (change.type === 'two_factor') {
      await resetTwoFactor(tx, change.userId);
      await audit(tx, orgId, actor.userId, 'member.two_factor.reset', change.userId);
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
    await revokeKeysOf(tx, orgId, actor.userId, change.userId);
    await audit(tx, orgId, actor.userId, 'member.removed', change.userId);
    return 'done';
  });
}

/** Two-step sign-in off for a person (a lost phone), and every session ended: the next sign-in sets it up again where it is required. */
export async function resetTwoFactor(db: Database | Tx, userId: string) {
  await db.delete(authTwoFactors).where(eq(authTwoFactors.userId, userId));
  await db.update(authUsers).set({ twoFactorEnabled: false }).where(eq(authUsers.id, userId));
  await db.delete(authSessions).where(eq(authSessions.userId, userId));
}

/** How many teams a person belongs to. */
export async function membershipCount(db: Database, userId: string) {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(memberships).where(eq(memberships.userId, userId));
  return row?.n ?? 0;
}

/** A person who can no longer make keys loses the ones they made, in every clinic of the organization, audited. */
async function revokeKeysOf(tx: Tx, orgId: string, actorId: string, memberId: string) {
  for (const clinicId of await clinicsOf(tx, orgId)) {
    await tx.execute(sql`select set_config('app.clinic_id', ${clinicId}, true)`);
    const revoked = (await tx.execute(sql`update api_keys set revoked_at = now() where clinic_id = ${clinicId} and created_by_user_id = ${memberId} and revoked_at is null returning id`)).rows as { id: string }[];
    if (revoked.length) {
      await tx.insert(auditLogs).values(revoked.map((k) => ({ clinicId, actor: `user:${actorId}`, action: 'api_key.revoked', entity: 'api_key', entityId: k.id })));
    }
  }
}

async function clinicsOf(tx: Tx, orgId: string) {
  return (await tx.select({ id: clinics.id }).from(clinics).where(eq(clinics.orgId, orgId))).map((c) => c.id);
}

/** Whether this organization removed the person from its team before (its audit log says so). */
async function removedHere(tx: Tx, orgId: string, userId: string) {
  for (const clinicId of await clinicsOf(tx, orgId)) {
    await tx.execute(sql`select set_config('app.clinic_id', ${clinicId}, true)`);
    const [row] = await tx.select({ id: auditLogs.id }).from(auditLogs)
      .where(and(eq(auditLogs.clinicId, clinicId), eq(auditLogs.action, 'member.removed'), eq(auditLogs.entityId, userId))).limit(1);
    if (row) return true;
  }
  return false;
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
