// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { authUsers, memberships } from '../auth-schema';
import type { Database, Tx } from '../client';
import { auditLogs, clinics } from '../schema';

export type AuditEntry = typeof auditLogs.$inferInsert;

/**
 * "p:" and the first 16 hex characters of a sha256 of the sorted patient ids a view
 * showed. Part of a view's entity id, so a refresh that shows someone new is a new
 * view and writes a new row, while the ids themselves stay out of the key.
 */
export function patientSetKey(patientIds: Iterable<string>) {
  const ids = [...new Set(patientIds)].sort();
  return `p:${createHash('sha256').update(ids.join(',')).digest('hex').slice(0, 16)}`;
}

/**
 * Records a view of patient data inside the transaction that read it.
 *
 * Screens that refresh on a timer (the schedule, the call list) would otherwise
 * write the same row every 30 seconds for as long as they stay open. With `window`,
 * a repeat of exactly the same view by the same person within that many minutes is
 * covered by the row already there. "Exactly the same" is the entity id, which
 * callers build from every parameter of the view and patientSetKey of who it
 * showed: a different filter, page or set of patients is always a new row.
 */
export async function recordView(tx: Tx, entry: AuditEntry, window = 0) {
  if (window > 0) {
    const [recent] = await tx.select({ id: auditLogs.id }).from(auditLogs).where(and(
      eq(auditLogs.clinicId, entry.clinicId), eq(auditLogs.actor, entry.actor), eq(auditLogs.action, entry.action),
      entry.entityId ? eq(auditLogs.entityId, entry.entityId) : isNull(auditLogs.entityId),
      gt(auditLogs.at, sql`now() - make_interval(mins => ${window})`),
    )).limit(1);
    if (recent) return;
  }
  await tx.insert(auditLogs).values(entry);
}

/**
 * The names of a clinic's staff, for "booked by Jordan". Owner connection: the
 * application role has no grant on auth tables. Only people who are members of the
 * clinic's organization are returned, whatever ids are asked for.
 */
export async function staffNames(db: Database, clinicId: string, userIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return new Map();
  const rows = await db.select({ id: authUsers.id, name: authUsers.name }).from(authUsers)
    .innerJoin(memberships, eq(memberships.userId, authUsers.id))
    .innerJoin(clinics, eq(clinics.orgId, memberships.organizationId))
    .where(and(eq(clinics.id, clinicId), inArray(authUsers.id, ids)));
  return new Map(rows.map((r) => [r.id, r.name]));
}
