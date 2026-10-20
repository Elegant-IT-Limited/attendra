// SPDX-License-Identifier: AGPL-3.0-only
// What a hosting layer needs to open and run accounts: a new organization with its
// clinic, a phone number pointed at a clinic, and the minutes it used. Owner connection;
// none of it reads patient data.
import { ClinicConfig, PACKS } from '@attendra/core';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { authAccounts, authSessions, authTwoFactors, authUsers, memberships } from '../auth-schema';
import type { Database } from '../client';
import { auditLogs, calls, clinics, organizations } from '../schema';

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
    await tx.execute(sql`update clinics set config = ${JSON.stringify({ ...config, phoneNumbers })}::jsonb, config_version = config_version + 1 where id = ${clinicId}`);
    return true;
  });
}

/** Stops a number reaching any clinic, as when an account is closed. The clinic keeps it in its settings until changed. */
export async function releaseNumber(db: Database, e164: string): Promise<boolean> {
  const rows = await db.execute(sql`update phone_numbers set status = 'released' where e164 = ${e164} and status = 'active' returning e164`);
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

/**
 * Deletes a clinic closed at least 30 days ago, with everything recorded for it: calls,
 * transcripts, patients, appointments, requests, texts, documents, webhooks, keys and its
 * audit log. An open clinic, or one closed more recently, is left as it is.
 */
export async function purgeClosedClinic(db: Database, clinicId: string, now = new Date()): Promise<'purged' | 'not_found' | 'open' | 'recent'> {
  return db.transaction(async (tx) => {
    const [c] = await tx.select({ closedAt: clinics.closedAt }).from(clinics).where(eq(clinics.id, clinicId)).for('update');
    if (!c) return 'not_found';
    if (!c.closedAt) return 'open';
    if (c.closedAt.getTime() > now.getTime() - CLOSED_KEPT_DAYS * 86_400_000) return 'recent';
    // row-level security applies to this connection too: the clinic's own rows only
    await tx.execute(sql`select set_config('app.clinic_id', ${clinicId}, true)`);
    // the rows that point at others go first; a patient and the call that created it point at each other
    const steps = [
      sql`delete from webhook_attempts where clinic_id = ${clinicId}`,
      sql`delete from webhook_events where clinic_id = ${clinicId}`,
      sql`delete from webhook_endpoints where clinic_id = ${clinicId}`,
      sql`delete from task_notes where clinic_id = ${clinicId}`,
      sql`delete from tasks where clinic_id = ${clinicId}`,
      sql`delete from appointments where clinic_id = ${clinicId}`,
      sql`delete from call_summaries where clinic_id = ${clinicId}`,
      sql`update patients set created_by_call_id = null where clinic_id = ${clinicId} and created_by_call_id is not null`,
      sql`delete from calls where clinic_id = ${clinicId}`,
      sql`delete from patients where clinic_id = ${clinicId}`,
      sql`delete from knowledge_documents where clinic_id = ${clinicId}`,
      sql`delete from sms_messages where clinic_id = ${clinicId}`,
      sql`delete from sms_opt_outs where clinic_id = ${clinicId}`,
      sql`delete from api_keys where clinic_id = ${clinicId}`,
      sql`delete from audit_logs where clinic_id = ${clinicId}`,
      sql`delete from phone_numbers where clinic_id = ${clinicId}`,
    ];
    for (const step of steps) await tx.execute(step);
    await tx.delete(clinics).where(eq(clinics.id, clinicId));
    return 'purged';
  });
}

/** Phone calls in [from, to): how many, and their length in seconds, start to end. Browser test calls are not counted. */
export async function phoneUsage(db: Database, clinicId: string, from: Date, to: Date): Promise<{ calls: number; seconds: number }> {
  const [row] = (await db.execute(sql`
    select count(*)::int as calls, coalesce(sum(ceil(extract(epoch from (ended_at - started_at)))), 0)::int as seconds
    from calls where clinic_id = ${clinicId} and channel = 'phone' and ended_at is not null and started_at >= ${from} and started_at < ${to}`)).rows as [{ calls: number; seconds: number }];
  return { calls: Number(row.calls), seconds: Number(row.seconds) };
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
    if (alone.length) await tx.delete(organizations).where(inArray(organizations.id, alone));
    await tx.delete(authSessions).where(eq(authSessions.userId, user.id));
    await tx.delete(authTwoFactors).where(eq(authTwoFactors.userId, user.id));
    await tx.delete(authAccounts).where(eq(authAccounts.userId, user.id));
    await tx.delete(authUsers).where(eq(authUsers.id, user.id));
    return 'removed';
  });
}
