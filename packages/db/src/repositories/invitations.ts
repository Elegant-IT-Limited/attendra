// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { authUsers, clinicAccess, invitations, memberships } from '../auth-schema';
import type { Database, Tx } from '../client';
import { auditLogs, clinics, organizations } from '../schema';
import { grant } from './team';
import type { StaffRole } from './front-desk';

/** How long an invitation waits for an answer. */
export const INVITATION_DAYS = 7;

export type InvitationResult = 'done' | 'not_found' | 'already_member' | 'owner_grant' | 'owner_protected' | 'all_locations_owner_only';

const normalise = (email: string) => email.trim().toLowerCase();

/**
 * Invites an email to a location's team, with its audit rows, in one transaction with the
 * team locked. Access is per location (migration 0046): the invitation opens this location
 * only, with its role. Two ways to reach more than one:
 *   * `allLocations` (owners only): one invitation per open location of the business, tied
 *     by a group id, so one Accept answers them all; locations where the person already
 *     works are skipped;
 *   * the role owner, which is account-wide by itself: one invitation, every location on accept.
 * Only an owner invites an owner. Sending it again to an address still invited to a location
 * renews that invitation (new role, 7 more days). Whether the address has an Attendra account
 * is not this function's question: the caller answers every address the same way.
 */
export async function inviteToTeam(db: Database, clinicId: string, actor: { userId: string; role: StaffRole },
  invite: { email: string; role: StaffRole; approvesRefills?: boolean; allLocations?: boolean }, now = new Date()): Promise<{ result: 'done'; id: string; ids: string[]; expiresAt: Date; clinicName: string; organizationName: string; locations: string[] } | { result: Exclude<InvitationResult, 'done'> }> {
  const email = normalise(invite.email);
  return db.transaction(async (tx) => {
    const [clinic] = await tx.select({ name: clinics.name, orgId: clinics.orgId, orgName: organizations.name }).from(clinics)
      .innerJoin(organizations, eq(organizations.id, clinics.orgId)).where(and(eq(clinics.id, clinicId), isNull(clinics.closedAt)));
    if (!clinic) return { result: 'not_found' as const };
    const orgId = clinic.orgId;
    await tx.execute(sql`select id from memberships where organization_id = ${orgId} for update`);
    if (invite.role === 'owner' && actor.role !== 'owner') return { result: 'owner_grant' as const };
    if (invite.allLocations && actor.role !== 'owner') return { result: 'all_locations_owner_only' as const };
    const targets = invite.allLocations && invite.role !== 'owner'
      ? await tx.select({ id: clinics.id, name: clinics.name }).from(clinics).where(and(eq(clinics.orgId, orgId), isNull(clinics.closedAt))).orderBy(asc(clinics.name))
      : [{ id: clinicId, name: clinic.name }];
    // where the person already works, nothing to send; an owner works everywhere in the business
    const working = new Set((await tx.select({ clinicId: clinicAccess.clinicId }).from(clinicAccess).innerJoin(authUsers, eq(authUsers.id, clinicAccess.userId))
      .where(and(eq(authUsers.email, email), inArray(clinicAccess.clinicId, targets.map((t) => t.id))))).map((r) => r.clinicId));
    const ownerAlready = invite.role === 'owner' && (await tx.select({ id: memberships.id }).from(memberships).innerJoin(authUsers, eq(authUsers.id, memberships.userId))
      .where(and(eq(memberships.organizationId, orgId), eq(authUsers.email, email))).limit(1)).length > 0;
    const open = invite.role === 'owner' ? (ownerAlready ? [] : targets) : targets.filter((t) => !working.has(t.id));
    if (!open.length) return { result: 'already_member' as const };
    const expiresAt = new Date(now.getTime() + INVITATION_DAYS * 86_400_000);
    const groupId = open.length > 1 ? crypto.randomUUID() : null;
    const ids: string[] = [];
    for (const target of open) {
      await lapse(tx, now, sql`clinic_id = ${target.id} and email = ${email}`);
      const values = { clinicId: target.id, role: invite.role, approvesRefills: invite.role !== 'viewer' && !!invite.approvesRefills, inviterId: actor.userId, expiresAt, groupId };
      const [pending] = await tx.select({ id: invitations.id, role: invitations.role }).from(invitations)
        .where(and(eq(invitations.clinicId, target.id), eq(invitations.email, email), eq(invitations.status, 'pending'))).for('update');
      // a manager does not turn an owner's invitation into another one
      if (pending?.role === 'owner' && actor.role !== 'owner') return { result: 'owner_protected' as const };
      const id = pending?.id ?? crypto.randomUUID();
      if (pending) await tx.update(invitations).set(values).where(eq(invitations.id, id));
      else await tx.insert(invitations).values({ id, organizationId: orgId, email, status: 'pending', createdAt: now, ...values });
      await audit(tx, [target.id], `user:${actor.userId}`, `member.invited:${invite.role}`, id, now);
      ids.push(id);
    }
    return { result: 'done' as const, id: ids[0]!, ids, expiresAt, clinicName: clinic.name, organizationName: clinic.orgName, locations: open.map((t) => t.name) };
  });
}

/**
 * The invitations a location is waiting on, oldest first, with who sent each. Only reads: a lapsed one is
 * left out by its date, and the worker closes it and audits it (lapseInvitations).
 */
export async function teamInvitations(db: Database, clinicId: string, now = new Date()) {
  const rows = await db.select({
    id: invitations.id, email: invitations.email, role: invitations.role, approvesRefills: invitations.approvesRefills,
    invitedBy: authUsers.name, createdAt: invitations.createdAt, expiresAt: invitations.expiresAt, allLocations: sql<boolean>`${invitations.groupId} is not null`,
  }).from(invitations).innerJoin(authUsers, eq(authUsers.id, invitations.inviterId))
    .where(and(eq(invitations.clinicId, clinicId), eq(invitations.status, 'pending'), gt(invitations.expiresAt, now)))
    .orderBy(asc(invitations.createdAt));
  return rows.map((r) => ({ ...r, role: r.role as StaffRole }));
}

/** Cancels one of this location's open invitations. Only an owner cancels an owner's. Audited. */
export async function cancelInvitation(db: Database, clinicId: string, actor: { userId: string; role: StaffRole }, id: string, now = new Date()): Promise<InvitationResult> {
  await lapseInvitations(db, now);
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ role: invitations.role }).from(invitations)
      .where(and(eq(invitations.id, id), eq(invitations.clinicId, clinicId), eq(invitations.status, 'pending'))).for('update');
    if (!row) return 'not_found';
    if (row.role === 'owner' && actor.role !== 'owner') return 'owner_protected';
    await tx.update(invitations).set({ status: 'canceled', decidedAt: now }).where(eq(invitations.id, id));
    await audit(tx, [clinicId], `user:${actor.userId}`, 'member.invite.canceled', id, now);
    return 'done';
  });
}

/**
 * The open invitations for a signed-in person's email, one entry per invitation or per
 * "every location" group, with the locations it opens. A closed clinic's are left out.
 * Only reads, since the banner asks on every page: a lapsed one is left out by its date.
 */
export async function invitationsFor(db: Database, email: string, now = new Date()) {
  const rows = await db.select({
    id: invitations.id, groupId: invitations.groupId, clinicId: clinics.id, clinicName: clinics.name, organizationName: organizations.name,
    role: invitations.role, approvesRefills: invitations.approvesRefills, expiresAt: invitations.expiresAt,
  }).from(invitations).innerJoin(clinics, eq(clinics.id, invitations.clinicId)).innerJoin(organizations, eq(organizations.id, clinics.orgId))
    .where(and(eq(invitations.email, normalise(email)), eq(invitations.status, 'pending'), gt(invitations.expiresAt, now), isNull(clinics.closedAt)))
    .orderBy(asc(invitations.createdAt), asc(clinics.name));
  return group(rows);
}

type InvitationRow = { id: string; groupId: string | null; clinicId: string; clinicName: string; organizationName: string; role: string | null; approvesRefills: boolean; expiresAt: Date };
function group(rows: InvitationRow[]) {
  const out: { id: string; clinicId: string; clinicName: string; organizationName: string; role: StaffRole; approvesRefills: boolean; expiresAt: Date; locations: { id: string; name: string }[]; allLocations: boolean }[] = [];
  const byGroup = new Map<string, (typeof out)[number]>();
  for (const r of rows) {
    const known = r.groupId ? byGroup.get(r.groupId) : undefined;
    if (known) { known.locations.push({ id: r.clinicId, name: r.clinicName }); continue; }
    const entry = { id: r.id, clinicId: r.clinicId, clinicName: r.clinicName, organizationName: r.organizationName, role: r.role as StaffRole, approvesRefills: r.approvesRefills,
      expiresAt: r.expiresAt, locations: [{ id: r.clinicId, name: r.clinicName }], allLocations: !!r.groupId || r.role === 'owner' };
    if (r.groupId) byGroup.set(r.groupId, entry);
    out.push(entry);
  }
  return out;
}

export type InvitationState = 'pending' | 'accepted' | 'declined' | 'canceled' | 'expired' | 'other_address' | 'not_found';

/**
 * One invitation as its link shows it (/invite/<id>), for the signed-in person. Their own:
 * the clinic, the role, the locations and its state. Someone else's: only that it is for
 * another address, so a forwarded link tells nothing about the clinic. Unknown: not_found.
 */
export async function invitationById(db: Database, person: { email: string }, id: string, now = new Date()) {
  const [row] = await db.select({
    id: invitations.id, email: invitations.email, groupId: invitations.groupId, status: invitations.status, expiresAt: invitations.expiresAt,
    clinicId: clinics.id, clinicName: clinics.name, organizationName: organizations.name, role: invitations.role, approvesRefills: invitations.approvesRefills, closedAt: clinics.closedAt,
  }).from(invitations).innerJoin(clinics, eq(clinics.id, invitations.clinicId)).innerJoin(organizations, eq(organizations.id, clinics.orgId)).where(eq(invitations.id, id));
  if (!row) return { state: 'not_found' as const };
  if (row.email !== normalise(person.email)) return { state: 'other_address' as const };
  const lapsed = row.status === 'pending' && (row.expiresAt <= now || !!row.closedAt);
  const state = (lapsed ? 'expired' : row.status) as Exclude<InvitationState, 'other_address' | 'not_found'>;
  const siblings = row.groupId
    ? await db.select({ id: clinics.id, name: clinics.name }).from(invitations).innerJoin(clinics, eq(clinics.id, invitations.clinicId))
      .where(and(eq(invitations.groupId, row.groupId), isNull(clinics.closedAt))).orderBy(asc(clinics.name))
    : [{ id: row.clinicId, name: row.clinicName }];
  return {
    state, id: row.id, clinicId: row.clinicId, clinicName: row.clinicName, organizationName: row.organizationName, role: row.role as StaffRole,
    approvesRefills: row.approvesRefills, expiresAt: row.expiresAt, locations: siblings, allLocations: !!row.groupId || row.role === 'owner',
  };
}

/**
 * The invited person accepts or declines. Only an open invitation to their own email, so
 * an id alone does nothing; an "every location" invitation is answered for all its
 * locations at once. Accepting gives the invitation's role at each location (an owner's,
 * on the whole business); nothing about their password, two-step sign-in or other teams
 * changes. Each inviting location's audit log gets the row, written as the person.
 */
export async function answerInvitation(db: Database, person: { userId: string; email: string }, id: string, accept: boolean, now = new Date()): Promise<{ result: 'done'; clinicId: string } | { result: 'not_found' }> {
  await lapseInvitations(db, now);
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(invitations)
      .where(and(eq(invitations.id, id), eq(invitations.email, normalise(person.email)), eq(invitations.status, 'pending'), gt(invitations.expiresAt, now))).for('update');
    if (!row?.clinicId) return { result: 'not_found' as const };
    const all = row.groupId
      ? await tx.select().from(invitations).where(and(eq(invitations.groupId, row.groupId), eq(invitations.email, row.email), eq(invitations.status, 'pending'), gt(invitations.expiresAt, now))).for('update')
      : [row];
    await tx.execute(sql`select id from memberships where organization_id = ${row.organizationId} for update`);
    for (const inv of all) {
      if (!inv.clinicId) continue;
      if (accept) await grant(tx, inv.organizationId, inv.clinicId, person.userId, inv.role as StaffRole, inv.approvesRefills);
      await tx.update(invitations).set({ status: accept ? 'accepted' : 'declined', decidedAt: now }).where(eq(invitations.id, inv.id));
      await audit(tx, [inv.clinicId], `user:${person.userId}`, accept ? 'member.invite.accepted' : 'member.invite.declined', inv.id, now);
    }
    return { result: 'done' as const, clinicId: row.clinicId };
  });
}

/**
 * Closes every invitation whose 7 days are over, with an audit row dated when it lapsed, and says how
 * many. The worker runs it on a schedule; inviting, cancelling and answering run it before they change one.
 */
export async function lapseInvitations(db: Database, now = new Date()): Promise<number> {
  return db.transaction((tx) => lapse(tx, now));
}

async function lapse(tx: Tx, now: Date, where = sql`true`): Promise<number> {
  const lapsed = (await tx.execute(sql`update invitations set status = 'expired', decided_at = expires_at
    where status = 'pending' and expires_at <= ${now.toISOString()}::timestamptz and ${where}
    returning id, clinic_id, expires_at`)).rows as { id: string; clinic_id: string | null; expires_at: string | Date }[];
  for (const l of lapsed) if (l.clinic_id) await audit(tx, [l.clinic_id], 'system', 'member.invite.expired', l.id, new Date(l.expires_at));
  return lapsed.length;
}

/** One row in each location the invitation was for. */
async function audit(tx: Tx, clinicIds: string[], actor: string, action: string, invitationId: string, at: Date) {
  for (const id of clinicIds) {
    await tx.execute(sql`select set_config('app.clinic_id', ${id}, true)`);
    await tx.insert(auditLogs).values({ clinicId: id, actor, action, entity: 'invitation', entityId: invitationId, at });
  }
}
