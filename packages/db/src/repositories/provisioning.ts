// SPDX-License-Identifier: AGPL-3.0-only
// What a hosting layer needs to open and run accounts: a new organization with its
// clinic, a phone number pointed at a clinic, and the minutes it used. Owner connection;
// none of it reads patient data.
import { ClinicConfig } from '@attendra/core';
import { and, eq, sql } from 'drizzle-orm';
import { authUsers, memberships } from '../auth-schema';
import type { Database } from '../client';
import { clinics, organizations } from '../schema';

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
      await tx.execute(sql`update clinics set config = jsonb_set(config, '{phoneNumbers}', ${JSON.stringify(left)}::jsonb) where id = ${prev.id}`);
    }
    await tx.execute(sql`insert into phone_numbers (e164, clinic_id) values (${e164}, ${clinicId}) on conflict (e164) do update set clinic_id = excluded.clinic_id, status = 'active'`);
    const phoneNumbers = [e164, ...config.phoneNumbers.filter((n) => n !== e164)];
    await tx.execute(sql`update clinics set config = ${JSON.stringify({ ...config, phoneNumbers })}::jsonb where id = ${clinicId}`);
    return true;
  });
}

/** Stops a number reaching any clinic, as when an account is closed. The clinic keeps it in its settings until changed. */
export async function releaseNumber(db: Database, e164: string): Promise<boolean> {
  const rows = await db.execute(sql`update phone_numbers set status = 'released' where e164 = ${e164} and status = 'active' returning e164`);
  return rows.rows.length === 1;
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
