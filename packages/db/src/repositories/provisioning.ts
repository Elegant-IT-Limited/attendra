// SPDX-License-Identifier: AGPL-3.0-only
// What a hosting layer needs to open and run accounts: a new organization with its
// clinic, a phone number pointed at a clinic, and the minutes it used. Owner connection;
// none of it reads patient data.
import { ClinicConfig, DEFAULT_ANIMALS, managedList, PACKS } from '@attendra/core';
import { and, asc, eq, inArray, ne, type SQL, sql } from 'drizzle-orm';
import { authAccounts, authSessions, authTwoFactors, authUsers, clinicAccess, clinicMemberships, invitations, memberships } from '../auth-schema';
import type { Database } from '../client';
import type { PhiCipher } from '../crypto';
import { auditLogs, calls, clinics, organizations } from '../schema';
import { callerKey } from './calls';

/**
 * A new organization and its first clinic. The clinic's own number is not pointed at
 * Attendra: it only sets the country until a number that reaches the assistant is added.
 */
export async function createOrganizationWithClinic(db: Database, org: { id: string; name: string; plan: string }, config: ClinicConfig) {
  const c = ClinicConfig.parse(config);
  await db.transaction(async (tx) => {
    await tx.insert(organizations).values({ id: org.id, name: org.name, slug: org.id, plan: org.plan });
    await tx.insert(clinics).values({ id: c.id, orgId: org.id, name: c.name, timezone: c.timezone, config: c });
  });
}

/**
 * A separate business on a login that already exists: a new organization and its first
 * clinic, with this login as its owner. Nothing is copied from their other clinics. For an
 * owner opening another business, and for a login that can open no clinic at all (invited
 * once and removed, or whose clinic was deleted), so it is never a dead end. Someone who
 * works at a clinic without owning one is refused, checked here: a work email belongs to the
 * clinic, so they sign up with another. Audited in the new clinic as `organization.created.by_owner`.
 */
export async function openOrganizationForOwner(db: Database, userId: string, org: { id: string; name: string; plan: string }, config: ClinicConfig): Promise<'not_found' | 'not_confirmed' | 'not_an_owner' | 'opened'> {
  const c = ClinicConfig.parse(config);
  return db.transaction(async (tx) => {
    const [user] = await tx.select({ verified: authUsers.emailVerified }).from(authUsers).where(eq(authUsers.id, userId));
    if (!user) return 'not_found';
    if (!user.verified) return 'not_confirmed';
    const [owns] = await tx.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.userId, userId), eq(memberships.role, 'owner'))).limit(1);
    const [worksSomewhere] = await tx.select({ id: clinicAccess.clinicId }).from(clinicAccess).where(eq(clinicAccess.userId, userId)).limit(1);
    if (!owns && worksSomewhere) return 'not_an_owner';
    await tx.insert(organizations).values({ id: org.id, name: org.name, slug: org.id, plan: org.plan });
    await tx.insert(clinics).values({ id: c.id, orgId: org.id, name: c.name, timezone: c.timezone, config: c });
    await tx.insert(memberships).values({ id: crypto.randomUUID(), organizationId: org.id, userId, role: 'owner' });
    await tx.insert(auditLogs).values({ clinicId: c.id, actor: `user:${userId}`, action: 'organization.created.by_owner', entity: 'organization', entityId: org.id });
    return 'opened';
  });
}

/** What a new location takes from the organization's first clinic: the same assistant. Hours, doctors, address, transfers and hospitals are its own. */
const SHARED = ['texting', 'languages', 'primaryLanguage', 'assistantName', 'voice', 'retentionDays', 'faqs', 'requestTopics', 'customFields', 'menuLinks', 'talk'] as const;

/**
 * Another clinic (a second location) in an organization, with the settings the first
 * one shares. Audited on the first clinic as `clinic.created`. Null when there is no
 * such organization.
 */
export async function addClinicToOrganization(db: Database, orgId: string, config: ClinicConfig): Promise<string | null> {
  return db.transaction(async (tx) => {
    const [first] = await tx.select({ id: clinics.id, config: clinics.config }).from(clinics).where(eq(clinics.orgId, orgId)).orderBy(asc(clinics.createdAt)).limit(1);
    if (!first) return null;
    const from = ClinicConfig.parse(first.config);
    const shared = Object.fromEntries(SHARED.filter((k) => from[k] !== undefined).map((k) => [k, from[k]]));
    // a greeting names the clinic: the new one gets the suggested greeting with its own name, in the shared main language
    const lang = from.primaryLanguage;
    const c = ClinicConfig.parse({ ...config, ...shared, greeting: PACKS[lang].greeting({ assistantName: from.assistantName ?? null, clinicName: config.name }) });
    await tx.insert(clinics).values({ id: c.id, orgId, name: c.name, timezone: c.timezone, config: c });
    await tx.insert(auditLogs).values({ clinicId: first.id, actor: 'provisioning', action: 'clinic.created', entity: 'clinic', entityId: c.id });
    return c.id;
  });
}

/**
 * Points a number at a clinic: calls to it reach this clinic's assistant, and texts are
 * sent from it (it goes first in the clinic's numbers). A number answers for one clinic,
 * so it leaves the one it belonged to. False when there is no such clinic.
 */
export async function assignNumber(db: Database, clinicId: string, e164: string): Promise<boolean> {
  if (!/^\+[1-9]\d{7,14}$/.test(e164)) throw new Error('expected E.164, like +13035550100');
  return db.transaction(async (tx) => {
    const [row] = (await tx.execute(sql`select config from clinics where id = ${clinicId} for update`)).rows as [{ config: unknown }?];
    if (!row) return false;
    const config = ClinicConfig.parse(row.config);
    const [prev] = (await tx.execute(sql`select c.id, c.config from phone_numbers p join clinics c on c.id = p.clinic_id where p.e164 = ${e164} and c.id <> ${clinicId}`)).rows as [{ id: string; config: { phoneNumbers: string[] } }?];
    if (prev) {
      const left = prev.config.phoneNumbers.filter((n) => n !== e164);
      await tx.execute(sql`update clinics set config = jsonb_set(config, '{phoneNumbers}', ${JSON.stringify(left)}::jsonb), config_version = config_version + 1 where id = ${prev.id}`);
    }
    await tx.execute(sql`insert into phone_numbers (e164, clinic_id) values (${e164}, ${clinicId}) on conflict (e164) do update set clinic_id = excluded.clinic_id, status = 'active'`);
    const phoneNumbers = [e164, ...config.phoneNumbers.filter((n) => n !== e164)];
    // who got which number, and when: the clinic's audit log shows it
    await tx.execute(sql`insert into audit_logs (clinic_id, actor, action, entity, entity_id) values (${clinicId}, 'hosting', 'number.assigned', 'phone_number', ${e164})`);
    await tx.execute(sql`update clinics set config = ${JSON.stringify({ ...config, phoneNumbers })}::jsonb, config_version = config_version + 1 where id = ${clinicId}`);
    return true;
  });
}

/** Stops a number reaching any clinic, as when an account is closed. The clinic keeps it in its settings until changed. */
export async function releaseNumber(db: Database, e164: string): Promise<boolean> {
  const rows = await db.execute(sql`update phone_numbers set status = 'released' where e164 = ${e164} and status = 'active' returning clinic_id`);
  const [row] = rows.rows as { clinic_id: string }[];
  if (row) await db.execute(sql`insert into audit_logs (clinic_id, actor, action, entity, entity_id) values (${row.clinic_id}, 'hosting', 'number.released', 'phone_number', ${e164})`);
  return rows.rows.length === 1;
}

/** Sets the plan the hosting layer keeps for a clinic, or clears it with null. False when there is no such clinic. */
export async function setHostingPlan(db: Database, clinicId: string, plan: Record<string, unknown> | null): Promise<boolean> {
  const rows = await db.update(clinics).set({ hostingPlan: plan }).where(eq(clinics.id, clinicId)).returning({ id: clinics.id });
  return rows.length === 1;
}

/** The plan the hosting layer set for a clinic, as stored; null when it set none. */
export async function hostingPlanOf(db: Database, clinicId: string): Promise<unknown> {
  const [row] = await db.select({ plan: clinics.hostingPlan }).from(clinics).where(eq(clinics.id, clinicId));
  return row?.plan ?? null;
}

/** Days a closed clinic can be opened again before the hosting layer may delete it. */
export const CLOSED_KEPT_DAYS = 30;

/**
 * Closes a clinic (a location its organization removed) or opens it again. Closed, it leaves
 * every member's dashboard, its numbers stop reaching the assistant and its API keys are
 * revoked; nothing is deleted. Closing again keeps the first date. False when there is no such clinic.
 */
export async function setClinicClosed(db: Database, clinicId: string, closed: boolean, now = new Date()): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx.update(clinics).set({ closedAt: closed ? sql`coalesce(${clinics.closedAt}, ${now})` : null })
      .where(eq(clinics.id, clinicId)).returning({ id: clinics.id });
    if (!rows.length) return false;
    await tx.execute(sql`select set_config('app.clinic_id', ${clinicId}, true)`);
    if (closed) {
      await tx.execute(sql`update phone_numbers set status = 'released' where clinic_id = ${clinicId} and status = 'active'`);
      await tx.execute(sql`update api_keys set revoked_at = ${now} where clinic_id = ${clinicId} and revoked_at is null`);
    }
    await tx.insert(auditLogs).values({ clinicId, actor: 'provisioning', action: closed ? 'clinic.closed' : 'clinic.reopened', entity: 'clinic', entityId: clinicId });
    return true;
  });
}

/** A call with no end that started this recently is taken as still going; an older one was left open by a crash and never ended. */
export const UNFINISHED_CALL_HOURS = 6;

/** Why a purge is refused: open, closed too recently, a call still going, or a number that still reaches the clinic. */
export type PurgeBlocker = 'not_closed' | 'closed_recently' | 'call_in_progress' | 'number_assigned';
export type PurgeCounts = Record<string, number>;
export type PurgeOptions = {
  /** An open clinic, or one closed less than 30 days ago, may go too: a tester's clinic. */
  force?: boolean;
  /** Logins stay, with only the memberships of what goes taken away, so a tester can sign in and open a new clinic. */
  keepLogins?: boolean;
  /** Counts what would go, table by table, and changes nothing. */
  dryRun?: boolean;
  now?: Date;
};
export type PurgeOutcome =
  | { status: 'not_found' }
  | { status: 'refused'; blockers: PurgeBlocker[] }
  | { status: 'purged' | 'dry_run'; counts: PurgeCounts; blockers: PurgeBlocker[] };

/**
 * The clinic's own tables, in the order they are emptied: the rows that point at others go
 * first. A patient and the call that created it point at each other, so that link is cleared
 * before any of them.
 */
const CLINIC_TABLES = [
  'webhook_attempts', 'webhook_events', 'webhook_endpoints', 'task_notes', 'tasks', 'clinic_counters', 'appointments',
  'call_summaries', 'call_costs', 'call_actions', 'call_segments', 'call_search_keys', 'patient_search_keys', 'calls', 'patients',
  'knowledge_chunks', 'knowledge_documents', 'invitations', 'sms_messages', 'sms_opt_outs', 'api_keys', 'audit_logs', 'phone_numbers',
] as const;

/** Thrown inside a dry run's transaction, so everything it did is rolled back. */
class DryRunDone extends Error {}

/**
 * Deletes a clinic with everything recorded for it: calls, transcripts, the call's steps,
 * patients, appointments, requests, texts, documents and their chunks, webhooks, keys,
 * invitations sent from it, the worker's jobs about it and its audit log. When it was its
 * organization's last clinic, the organization goes too, with its team and invitations, and
 * every login left with no team (unless `keepLogins`). Without `force`, only a clinic closed
 * at least 30 days ago. Never while a call is still going, or while a number still reaches it
 * (the hosting layer releases its numbers first). A test scans every table for a clinic,
 * organization or user column, so a new table this forgets fails it.
 *
 * Counts are rows deleted per table. A dry run takes the very same steps in a transaction that
 * is rolled back, so its counts are what a real run would delete, by construction, and it
 * reports the blockers instead of stopping at them.
 */
export async function purgeClinic(db: Database, clinicId: string, opts: PurgeOptions = {}): Promise<PurgeOutcome> {
  const now = opts.now ?? new Date();
  let outcome: PurgeOutcome = { status: 'not_found' };
  try {
    await db.transaction(async (tx) => {
      const [c] = await tx.select({ closedAt: clinics.closedAt, orgId: clinics.orgId }).from(clinics).where(eq(clinics.id, clinicId)).for('update');
      if (!c) return;
      // row-level security applies to this connection too: the clinic's own rows only
      await tx.execute(sql`select set_config('app.clinic_id', ${clinicId}, true)`);
      const blockers: PurgeBlocker[] = [];
      if (!opts.force && !c.closedAt) blockers.push('not_closed');
      if (!opts.force && c.closedAt && c.closedAt.getTime() > now.getTime() - CLOSED_KEPT_DAYS * 86_400_000) blockers.push('closed_recently');
      const since = new Date(now.getTime() - UNFINISHED_CALL_HOURS * 3_600_000);
      if ((await tx.execute(sql`select 1 from calls where clinic_id = ${clinicId} and ended_at is null and started_at > ${since} limit 1`)).rows.length) blockers.push('call_in_progress');
      if ((await tx.execute(sql`select 1 from phone_numbers where clinic_id = ${clinicId} and status = 'active' limit 1`)).rows.length) blockers.push('number_assigned');
      if (blockers.length && !opts.dryRun) {
        outcome = { status: 'refused', blockers };
        return;
      }

      const counts: PurgeCounts = {};
      const tally = (table: string, n: number) => { if (n) counts[table] = (counts[table] ?? 0) + n; };
      await tx.execute(sql`update patients set created_by_call_id = null where clinic_id = ${clinicId} and created_by_call_id is not null`);
      for (const table of CLINIC_TABLES) tally(table, await deleteCounted(tx, sql`${sql.identifier(table)} where clinic_id = ${clinicId}`));
      // the people who worked only here: their logins go with the business if it goes, as an owner's do
      const team = (await tx.select({ userId: clinicMemberships.userId }).from(clinicMemberships).where(eq(clinicMemberships.clinicId, clinicId))).map((m) => m.userId);
      tally('clinic_memberships', (await tx.delete(clinicMemberships).where(eq(clinicMemberships.clinicId, clinicId)).returning({ id: clinicMemberships.id })).length);
      // the worker's jobs carry the clinic's id in their data (pg-boss, in its own schema, once the worker has run here)
      const [jobs] = (await tx.execute(sql`select to_regclass('pgboss.job') is not null as ok`)).rows as [{ ok: boolean }];
      if (jobs.ok) tally('pgboss.job', await deleteCounted(tx, sql`pgboss.job where data->>'clinicId' = ${clinicId}`));
      tally('clinics', (await tx.delete(clinics).where(eq(clinics.id, clinicId)).returning({ id: clinics.id })).length);
      const [left] = await tx.select({ id: clinics.id }).from(clinics).where(eq(clinics.orgId, c.orgId)).limit(1);
      const keepLogins = opts.keepLogins ?? false;
      if (!left) await removeOrganization(tx, c.orgId, team, keepLogins, tally);
      else if (!keepLogins) await removeLoginsWithNoTeam(tx, team, tally);
      outcome = { status: opts.dryRun ? 'dry_run' : 'purged', counts, blockers };
      if (opts.dryRun) throw new DryRunDone();
    });
  } catch (err) {
    if (!(err instanceof DryRunDone)) throw err;
  }
  return outcome;
}

type Tally = (table: string, n: number) => void;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Deletes `from` (a table and its condition) and says how many rows went. */
async function deleteCounted(tx: Pick<Database, 'execute'>, from: SQL): Promise<number> {
  const [row] = (await tx.execute(sql`with gone as (delete from ${from} returning 1) select count(*)::int as n from gone`)).rows as [{ n: number }];
  return Number(row.n);
}

/** An organization with no clinic left: its owners, its invitations, and (unless kept) the logins that belonged to no other team. */
async function removeOrganization(tx: Tx, orgId: string, staff: string[], keepLogins: boolean, tally: Tally) {
  const owners = (await tx.select({ userId: memberships.userId }).from(memberships).where(eq(memberships.organizationId, orgId))).map((m) => m.userId);
  tally('invitations', (await tx.delete(invitations).where(eq(invitations.organizationId, orgId)).returning({ id: invitations.id })).length);
  tally('memberships', (await tx.delete(memberships).where(eq(memberships.organizationId, orgId)).returning({ id: memberships.id })).length);
  await tx.update(authSessions).set({ activeOrganizationId: null }).where(eq(authSessions.activeOrganizationId, orgId));
  tally('organizations', (await tx.delete(organizations).where(eq(organizations.id, orgId)).returning({ id: organizations.id })).length);
  if (!keepLogins) await removeLoginsWithNoTeam(tx, [...new Set([...owners, ...staff])], tally);
}

/** Of these people, the ones who can open no location any more lose their login, with what hangs on it. */
async function removeLoginsWithNoTeam(tx: Tx, team: string[], tally: Tally) {
  if (!team.length) return;
  const staying = new Set((await tx.select({ userId: clinicAccess.userId }).from(clinicAccess).where(inArray(clinicAccess.userId, team))).map((m) => m.userId));
  const gone = team.filter((u) => !staying.has(u));
  if (!gone.length) return;
  // invitations they sent to other teams go with them, as their sign-in does
  tally('invitations', (await tx.delete(invitations).where(inArray(invitations.inviterId, gone)).returning({ id: invitations.id })).length);
  tally('auth_sessions', (await tx.delete(authSessions).where(inArray(authSessions.userId, gone)).returning({ id: authSessions.id })).length);
  tally('auth_two_factors', (await tx.delete(authTwoFactors).where(inArray(authTwoFactors.userId, gone)).returning({ id: authTwoFactors.id })).length);
  tally('auth_accounts', (await tx.delete(authAccounts).where(inArray(authAccounts.userId, gone)).returning({ id: authAccounts.id })).length);
  tally('auth_users', (await tx.delete(authUsers).where(inArray(authUsers.id, gone)).returning({ id: authUsers.id })).length);
}

/**
 * Phone calls in [from, to): how many, and their length in seconds, start to end; and the texts sent. Browser
 * test calls are not counted, nor calls taken while the assistant was paused (a short line, then the front desk).
 */
export async function phoneUsage(db: Database, clinicId: string, from: Date, to: Date): Promise<{ calls: number; seconds: number; texts: number }> {
  const [row] = (await db.execute(sql`
    select count(*)::int as calls, coalesce(sum(ceil(extract(epoch from (ended_at - started_at)))), 0)::int as seconds
    from calls where clinic_id = ${clinicId} and channel = 'phone' and ended_at is not null and started_at >= ${from} and started_at < ${to}
      and not exists (select 1 from call_actions a where a.call_id = calls.id and a.tool = 'answering_paused')`)).rows as [{ calls: number; seconds: number }];
  // a text counts once the carrier took it (Twilio gave it an id), delivered or not; one refused before sending never does
  const [sms] = (await db.execute(sql`
    select count(*)::int as texts from sms_messages
    where clinic_id = ${clinicId} and provider_sid is not null and sent_at >= ${from} and sent_at < ${to}`)).rows as [{ texts: number }];
  return { calls: Number(row.calls), seconds: Number(row.seconds), texts: Number(sms.texts) };
}

/**
 * Phone calls that started since a moment, ended or not: how many, when the last one began,
 * and, given a number, whether one came from it (compared by its keyed hash, never stored
 * or returned). For the hosting layer's forwarding check and its quiet-line alert.
 */
export async function phoneCallsSince(db: Database, cipher: PhiCipher, clinicId: string, since: Date, from?: string): Promise<{ calls: number; lastCallAt: string | null; heard: boolean | null }> {
  const [row] = (await db.execute(sql`
    select count(*)::int as calls, max(started_at) as last_at
    from calls where clinic_id = ${clinicId} and channel = 'phone' and started_at >= ${since}`)).rows as [{ calls: number; last_at: string | Date | null }];
  let heard: boolean | null = null;
  if (from) {
    const [match] = (await db.execute(sql`
      select count(*)::int as n from calls
      where clinic_id = ${clinicId} and channel = 'phone' and started_at >= ${since} and from_hash = ${cipher.hash(callerKey(clinicId, from))}`)).rows as [{ n: number }];
    heard = Number(match.n) > 0;
  }
  return { calls: Number(row.calls), lastCallAt: row.last_at ? new Date(row.last_at).toISOString() : null, heard };
}

/** The owners of the organization a clinic belongs to, for account email. */
export async function clinicOwners(db: Database, clinicId: string): Promise<{ name: string; email: string; emailVerified: boolean }[]> {
  return db.select({ name: authUsers.name, email: authUsers.email, emailVerified: authUsers.emailVerified })
    .from(clinics).innerJoin(memberships, eq(memberships.organizationId, clinics.orgId)).innerJoin(authUsers, eq(authUsers.id, memberships.userId))
    .where(and(eq(clinics.id, clinicId), eq(memberships.role, 'owner'))).orderBy(authUsers.name);
}

/** Marks an account's email address as confirmed, so it can sign in. False when there is no such account. */
export async function confirmEmail(db: Database, email: string): Promise<boolean> {
  const rows = await db.update(authUsers).set({ emailVerified: true }).where(eq(authUsers.email, email.trim().toLowerCase())).returning({ id: authUsers.id });
  return rows.length === 1;
}

/**
 * Removes an account whose email address was never confirmed, with the organization and
 * clinics it opened alone, so the address can sign up again: a sign-up the hosting layer
 * could not finish, or one made with someone else's address. Never an account that was
 * confirmed, an organization someone else belongs to, or a clinic that has had a call.
 */
export async function removeUnconfirmedAccount(db: Database, email: string, opts: { createdBefore?: Date } = {}): Promise<'removed' | 'not_found' | 'confirmed' | 'in_use' | 'recent'> {
  return db.transaction(async (tx) => {
    const [user] = await tx.select({ id: authUsers.id, verified: authUsers.emailVerified, createdAt: authUsers.createdAt }).from(authUsers).where(eq(authUsers.email, email.trim().toLowerCase()));
    if (!user) return 'not_found';
    if (user.verified) return 'confirmed';
    if (opts.createdBefore && user.createdAt > opts.createdBefore) return 'recent';
    const orgs = (await tx.select({ orgId: memberships.organizationId }).from(memberships).where(eq(memberships.userId, user.id))).map((r) => r.orgId);
    // organizations this person opened alone: those go with them
    const alone: string[] = [];
    for (const orgId of orgs) {
      const [other] = await tx.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.organizationId, orgId), ne(memberships.userId, user.id))).limit(1);
      if (!other) alone.push(orgId);
    }
    const clinicIds = alone.length ? (await tx.select({ id: clinics.id }).from(clinics).where(inArray(clinics.orgId, alone))).map((c) => c.id) : [];
    // calls and the audit log are behind row-level security, even for this connection: one clinic at a time
    for (const clinicId of clinicIds) {
      await tx.execute(sql`select set_config('app.clinic_id', ${clinicId}, true)`);
      const [used] = await tx.select({ id: calls.id }).from(calls).where(eq(calls.clinicId, clinicId)).limit(1);
      if (used) return 'in_use'; // checked for every clinic before anything is removed
    }
    for (const clinicId of clinicIds) {
      await tx.execute(sql`select set_config('app.clinic_id', ${clinicId}, true)`);
      await tx.delete(auditLogs).where(eq(auditLogs.clinicId, clinicId));
    }
    if (clinicIds.length) await tx.delete(clinics).where(inArray(clinics.id, clinicIds));
    await tx.delete(memberships).where(eq(memberships.userId, user.id));
    await tx.delete(clinicMemberships).where(eq(clinicMemberships.userId, user.id));
    if (alone.length) await tx.delete(organizations).where(inArray(organizations.id, alone));
    await tx.delete(authSessions).where(eq(authSessions.userId, user.id));
    await tx.delete(authTwoFactors).where(eq(authTwoFactors.userId, user.id));
    await tx.delete(authAccounts).where(eq(authAccounts.userId, user.id));
    await tx.delete(authUsers).where(eq(authUsers.id, user.id));
    return 'removed';
  });
}

/**
 * The animals list every vet clinic has from sign-up since 2026-11, given once to the clinics opened before
 * that whose list is empty (no list kept, and no vet with animals to derive one from). Counts only. With
 * `apply` false nothing is written. Safe to run more than once: a clinic with a list is left alone.
 */
export async function seedAnimalLists(db: Database, opts: { apply: boolean }): Promise<{ clinics: number; vet: number; empty: number; filled: number }> {
  const rows = await db.select({ id: clinics.id, config: clinics.config }).from(clinics);
  let vet = 0;
  let empty = 0;
  let filled = 0;
  for (const row of rows) {
    const parsed = ClinicConfig.safeParse(row.config);
    if (!parsed.success || parsed.data.industry !== 'vet') continue;
    vet++;
    if (managedList(parsed.data, 'categories').length) continue;
    empty++;
    if (!opts.apply) continue;
    const config = { ...parsed.data, lists: { ...parsed.data.lists, categories: [...DEFAULT_ANIMALS] } };
    await db.transaction(async (tx) => {
      await tx.update(clinics).set({ config, configVersion: sql`${clinics.configVersion} + 1`, configUpdatedAt: new Date(), configUpdatedBy: 'provisioning' }).where(eq(clinics.id, row.id));
      await tx.insert(auditLogs).values({ clinicId: row.id, actor: 'provisioning', action: 'clinic.list.updated.categories', entity: 'clinic', entityId: row.id });
    });
    filled++;
  }
  return { clinics: rows.length, vet, empty, filled };
}
