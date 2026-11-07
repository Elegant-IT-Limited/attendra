// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { authUsers, clinicAccess, userAvatars } from '../auth-schema';
import { type Database, setClinicScope } from '../client';
import { auditLogs, clinics } from '../schema';

/** The largest picture kept: the browser sends a 256 px WebP of about 30 KB. */
export const AVATAR_MAX_BYTES = 200 * 1024;
export type AvatarType = (typeof userAvatars.$inferSelect)['contentType'];

/**
 * A person's own name, changed by them. Audited in every open location they can open, as
 * user.name.changed, with neither the old name nor the new one in the row. Anyone may
 * change their own, whatever their role, and with no location at all (a person who has
 * not accepted an invitation yet). Owner connection: auth_users has no grant to the
 * application role.
 */
export async function renameUser(db: Database, userId: string, name: string, now = new Date()) {
  await db.transaction(async (tx) => {
    await tx.update(authUsers).set({ name, updatedAt: now }).where(eq(authUsers.id, userId));
    const theirs = await tx.select({ id: clinics.id }).from(clinics)
      .innerJoin(clinicAccess, eq(clinicAccess.clinicId, clinics.id)).where(and(eq(clinicAccess.userId, userId), isNull(clinics.closedAt)));
    for (const { id: clinicId } of theirs) {
      await setClinicScope(tx, clinicId);
      await tx.insert(auditLogs).values({ clinicId, actor: `user:${userId}`, action: 'user.name.changed', entity: 'member', entityId: userId });
    }
  });
}

/** Keeps a person's picture, replacing the one before. */
export async function saveAvatar(db: Database, userId: string, bytes: Buffer, contentType: AvatarType, now = new Date()) {
  await db.insert(userAvatars).values({ userId, bytes, contentType, updatedAt: now })
    .onConflictDoUpdate({ target: userAvatars.userId, set: { bytes, contentType, updatedAt: now } });
}

/** Removes a person's picture; false when there was none. */
export async function removeAvatar(db: Database, userId: string) {
  return (await db.delete(userAvatars).where(eq(userAvatars.userId, userId)).returning({ userId: userAvatars.userId })).length > 0;
}

/**
 * A person's picture, for someone who shares at least one location with them (or for
 * themselves). Anyone else gets null, the same as for a person with no picture, so a
 * stranger learns nothing about who exists.
 */
export async function avatarFor(db: Database, viewerId: string, userId: string) {
  if (viewerId !== userId) {
    const theirs = alias(clinicAccess, 'theirs');
    const [shared] = await db.select({ id: clinicAccess.clinicId }).from(clinicAccess)
      .innerJoin(theirs, eq(theirs.clinicId, clinicAccess.clinicId))
      .where(and(eq(clinicAccess.userId, viewerId), eq(theirs.userId, userId))).limit(1);
    if (!shared) return null;
  }
  const [row] = await db.select().from(userAvatars).where(eq(userAvatars.userId, userId));
  return row ?? null;
}

/** When each of these people last changed their picture: the version in its address. People with none are left out. */
export async function avatarStamps(db: Database, userIds: string[]): Promise<Map<string, Date>> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return new Map();
  const rows = await db.select({ userId: userAvatars.userId, updatedAt: userAvatars.updatedAt }).from(userAvatars).where(inArray(userAvatars.userId, ids));
  return new Map(rows.map((r) => [r.userId, r.updatedAt]));
}
