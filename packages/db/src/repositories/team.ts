// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import { authAccounts, authSessions, authTwoFactors, authUsers, authVerifications, clinicAccess, clinicMemberships, memberships, userAvatars } from '../auth-schema';
import type { Database, Tx } from '../client';
import { auditLogs, clinics, tasks } from '../schema';
import type { StaffRole } from './front-desk';

/** How long a temporary password works before it has to be issued again. */
export const TEMPORARY_PASSWORD_HOURS = 72;

/**
 * The people who can open this location, with their role here and whether two-step
 * sign-in is on: its owners (account-wide, every location of the business) and the
 * people invited to it. Owner connection: these are auth tables, which the application
 * role cannot read. There is no "last signed in": sessions do not record which clinic
 * they were for, so it would show sign-ins at other practices.
 */
export async function listMembers(db: Database, clinicId: string) {
  return db.select({
    userId: authUsers.id, name: authUsers.name, email: authUsers.email, role: clinicAccess.role, twoFactorEnabled: authUsers.twoFactorEnabled,
    mustChangePassword: authUsers.mustChangePassword, addedAt: clinicAccess.createdAt, approvesRefills: clinicAccess.approvesRefills, avatarAt: userAvatars.updatedAt,
    allLocations: clinicAccess.accountWide,
  }).from(clinicAccess).innerJoin(authUsers, eq(authUsers.id, clinicAccess.userId)).leftJoin(userAvatars, eq(userAvatars.userId, clinicAccess.userId))
    .where(eq(clinicAccess.clinicId, clinicId)).orderBy(authUsers.name);
}

/**
 * Who a request can be given to at a clinic: everyone who can open it and works
 * requests (every role but viewer), owners included, by name and whether they approve
 * refills. Owner connection, like listMembers; no email, nothing about their sign-in.
 */
export async function requestAssignees(db: Database, clinicId: string) {
  return db.select({ userId: authUsers.id, name: authUsers.name, approvesRefills: clinicAccess.approvesRefills, avatarAt: userAvatars.updatedAt }).from(clinicAccess)
    .innerJoin(authUsers, eq(authUsers.id, clinicAccess.userId)).leftJoin(userAvatars, eq(userAvatars.userId, clinicAccess.userId))
    .where(and(eq(clinicAccess.clinicId, clinicId), ne(clinicAccess.role, 'viewer'))).orderBy(authUsers.name);
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
 * One change to a location's team, with its audit rows, in one transaction.
 *
 * Access is per location (migration 0046): an admin, front desk or viewer is added to,
 * changed at and removed from this location only. An owner is account-wide: making
 * someone an owner opens every location of the business to them, removing an owner
 * removes them from the business, and an owner made something else keeps that role at
 * every location of the business (nobody loses access by surprise).
 *
 * The business's owners and this location's team are locked first (select ... for
 * update), so the checks below and the change see the same team: two managers removing
 * the last two owners at once end with one owner, not none. The rules: nobody changes,
 * removes or resets themselves here; only an owner touches an owner or makes one; the
 * last owner stays. Who may approve refills follows the same rules, except that an owner
 * may mark themselves. The audit row goes to this location, and to every location of the
 * business when the change is account-wide.
 */
export async function changeTeam(db: Database, clinicId: string, actor: { userId: string; role: StaffRole }, change: TeamChange, now = new Date()): Promise<TeamResult> {
  return db.transaction(async (tx) => {
    const [clinic] = await tx.select({ orgId: clinics.orgId }).from(clinics).where(eq(clinics.id, clinicId));
    if (!clinic) return 'not_found';
    const orgId = clinic.orgId;
    const ownerRows = (await tx.execute(sql`select user_id, approves_refills from memberships where organization_id = ${orgId} for update`)).rows as { user_id: string; approves_refills: boolean }[];
    const here = (await tx.execute(sql`select user_id, role, approves_refills from clinic_memberships where clinic_id = ${clinicId} for update`)).rows as { user_id: string; role: StaffRole; approves_refills: boolean }[];
    const ownerIds = new Set(ownerRows.map((r) => r.user_id));
    const team = [...ownerRows.map((r) => ({ ...r, role: 'owner' as StaffRole })), ...here.filter((r) => !ownerIds.has(r.user_id))];
    const target = team.find((r) => r.user_id === change.userId);
    const owners = ownerRows.length;
    const isOwner = actor.role === 'owner';
    const everywhere = await clinicsOf(tx, orgId);

    if (change.type === 'add') {
      if (target) return 'already_member';
      if (change.role === 'owner' && !isOwner) return 'owner_grant';
      if (change.passwordHash) {
        // someone removed earlier, coming back: only when they belong to no other team
        if (await belongsAnywhere(tx, change.userId)) return 'other_organizations';
        // and only by the practice that removed them: any other would be handed someone's login
        if (!(await removedHere(tx, orgId, change.userId))) return 'account_exists';
        await tx.update(authAccounts).set({ password: change.passwordHash, updatedAt: now })
          .where(and(eq(authAccounts.userId, change.userId), eq(authAccounts.providerId, 'credential')));
        await tx.delete(authSessions).where(eq(authSessions.userId, change.userId));
      }
      await grant(tx, orgId, clinicId, change.userId, change.role, !!change.approvesRefills);
      if (change.temporary) await markTemporaryPassword(tx, change.userId, now);
      const where = change.role === 'owner' ? everywhere : [clinicId];
      await audit(tx, where, actor.userId, `member.added:${change.role}`, change.userId);
      if (change.approvesRefills) await audit(tx, where, actor.userId, 'member.refill_approval.on', change.userId);
      return 'done';
    }

    if (!target) return 'not_found';
    const targetIsOwner = target.role === 'owner';
    if (change.type === 'refills') {
      if (change.userId === actor.userId && !isOwner) return 'self';
      if (targetIsOwner && !isOwner) return 'owner_protected';
      if (target.approves_refills === change.approves) return 'unchanged';
      if (targetIsOwner) await tx.update(memberships).set({ approvesRefills: change.approves }).where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, change.userId)));
      else await tx.update(clinicMemberships).set({ approvesRefills: change.approves }).where(and(eq(clinicMemberships.clinicId, clinicId), eq(clinicMemberships.userId, change.userId)));
      await audit(tx, targetIsOwner ? everywhere : [clinicId], actor.userId, `member.refill_approval.${change.approves ? 'on' : 'off'}`, change.userId);
      return 'done';
    }
    if (change.userId === actor.userId) return 'self';
    if (targetIsOwner && !isOwner) return 'owner_protected';

    if (change.type === 'role') {
      if (change.role === 'owner' && !isOwner) return 'owner_grant';
      if (change.role === target.role) return 'unchanged';
      if (targetIsOwner && owners <= 1) return 'last_owner';
      if (targetIsOwner) {
        // an owner made something else keeps that role at every location of the business
        await tx.delete(memberships).where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, change.userId)));
        for (const id of await clinicsOf(tx, orgId)) {
          await tx.insert(clinicMemberships).values({ id: crypto.randomUUID(), clinicId: id, userId: change.userId, role: change.role as Exclude<StaffRole, 'owner'>, approvesRefills: target.approves_refills })
            .onConflictDoUpdate({ target: [clinicMemberships.clinicId, clinicMemberships.userId], set: { role: change.role as Exclude<StaffRole, 'owner'> } });
        }
      } else if (change.role === 'owner') {
        await grant(tx, orgId, clinicId, change.userId, 'owner', target.approves_refills);
      } else {
        await tx.update(clinicMemberships).set({ role: change.role }).where(and(eq(clinicMemberships.clinicId, clinicId), eq(clinicMemberships.userId, change.userId)));
      }
      const where = targetIsOwner || change.role === 'owner' ? everywhere : [clinicId];
      await audit(tx, where, actor.userId, `member.role.changed:${change.role}`, change.userId);
      if (change.role !== 'owner' && change.role !== 'admin') await revokeKeysOf(tx, where, actor.userId, change.userId);
      return 'done';
    }

    if (change.type === 'reset' || change.type === 'two_factor') {
      // a password and a phone belong to the person, not to this team: one who also works for
      // another organization would be signed out there and locked out by a manager here
      if (await belongsAnywhere(tx, change.userId, orgId)) return 'other_organizations';
    }
    if (change.type === 'two_factor') {
      await resetTwoFactor(tx, change.userId);
      await audit(tx, [clinicId], actor.userId, 'member.two_factor.reset', change.userId);
      return 'done';
    }
    if (change.type === 'reset') {
      await tx.update(authAccounts).set({ password: change.passwordHash, updatedAt: now })
        .where(and(eq(authAccounts.userId, change.userId), eq(authAccounts.providerId, 'credential')));
      await markTemporaryPassword(tx, change.userId, now);
      await tx.delete(authSessions).where(eq(authSessions.userId, change.userId));
      await audit(tx, [clinicId], actor.userId, 'member.password.reset', change.userId);
      return 'done';
    }

    // remove: an owner leaves the business, anyone else leaves this location
    if (targetIsOwner && owners <= 1) return 'last_owner';
    const where = targetIsOwner ? everywhere : [clinicId];
    if (targetIsOwner) await tx.delete(memberships).where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, change.userId)));
    else await tx.delete(clinicMemberships).where(and(eq(clinicMemberships.clinicId, clinicId), eq(clinicMemberships.userId, change.userId)));
    // whatever they held goes back to the queue, in each location they left
    for (const id of where) {
      await tx.execute(sql`select set_config('app.clinic_id', ${id}, true)`);
      const released = await tx.update(tasks).set({ assigneeUserId: null, claimedAt: null })
        .where(and(eq(tasks.clinicId, id), eq(tasks.status, 'open'), eq(tasks.assigneeUserId, change.userId))).returning({ id: tasks.id });
      if (released.length) {
        await tx.insert(auditLogs).values(released.map((t) => ({ clinicId: id, actor: `user:${actor.userId}`, action: 'task.released.override', entity: 'task', entityId: t.id })));
      }
    }
    // their sessions go only when they belong nowhere else: the guard already rechecks
    // membership on every request, so access here ends at once either way
    if (!(await belongsAnywhere(tx, change.userId))) await tx.delete(authSessions).where(eq(authSessions.userId, change.userId));
    await revokeKeysOf(tx, where, actor.userId, change.userId);
    await audit(tx, where, actor.userId, 'member.removed', change.userId);
    return 'done';
  });
}

/**
 * Gives a person a role: an owner on the business (and no per-location rows there any
 * more), anyone else at this one location. Inside the caller's transaction.
 */
export async function grant(tx: Tx, orgId: string, clinicId: string, userId: string, role: StaffRole, approvesRefills: boolean) {
  if (role === 'owner') {
    await tx.insert(memberships).values({ id: crypto.randomUUID(), organizationId: orgId, userId, role, approvesRefills }).onConflictDoNothing();
    await tx.delete(clinicMemberships).where(and(eq(clinicMemberships.userId, userId), inArray(clinicMemberships.clinicId, tx.select({ id: clinics.id }).from(clinics).where(eq(clinics.orgId, orgId)))));
    return;
  }
  // an owner already opens every location: nothing to add
  const [owner] = await tx.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, userId)));
  if (owner) return;
  await tx.insert(clinicMemberships).values({ id: crypto.randomUUID(), clinicId, userId, role, approvesRefills: role !== 'viewer' && approvesRefills }).onConflictDoNothing();
}

/** Whether a person can open any location at all, or any outside one business. */
async function belongsAnywhere(tx: Tx, userId: string, exceptOrg?: string) {
  const rows = await tx.select({ orgId: clinics.orgId }).from(clinicAccess).innerJoin(clinics, eq(clinics.id, clinicAccess.clinicId))
    .where(exceptOrg ? and(eq(clinicAccess.userId, userId), ne(clinics.orgId, exceptOrg)) : eq(clinicAccess.userId, userId)).limit(1);
  return rows.length > 0;
}

/** Two-step sign-in off for a person (a lost phone), and every session ended: the next sign-in sets it up again where it is required. */
export async function resetTwoFactor(db: Database | Tx, userId: string) {
  await db.delete(authTwoFactors).where(eq(authTwoFactors.userId, userId));
  await db.update(authUsers).set({ twoFactorEnabled: false }).where(eq(authUsers.id, userId));
  await db.delete(authSessions).where(eq(authSessions.userId, userId));
}

/** How many locations a person can open, owners' included. */
export async function membershipCount(db: Database, userId: string) {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(clinicAccess).where(eq(clinicAccess.userId, userId));
  return row?.n ?? 0;
}

/** A person who can no longer make keys loses the ones they made at these locations, audited. */
async function revokeKeysOf(tx: Tx, clinicIds: string[], actorId: string, memberId: string) {
  for (const clinicId of clinicIds) {
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

async function audit(tx: Tx, clinicIds: string[], actorId: string, action: string, memberId: string) {
  for (const clinicId of clinicIds) {
    await tx.execute(sql`select set_config('app.clinic_id', ${clinicId}, true)`);
    await tx.insert(auditLogs).values({ clinicId, actor: `user:${actorId}`, action, entity: 'member', entityId: memberId });
  }
}

/** For the tests and the CLI: whether someone has any membership at all. */
export async function hasAnyMembership(db: Database, userId: string) {
  const [row] = await db.select({ id: clinicAccess.userId }).from(clinicAccess).where(eq(clinicAccess.userId, userId)).limit(1);
  return !!row;
}
