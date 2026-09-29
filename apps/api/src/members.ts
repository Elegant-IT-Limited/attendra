// SPDX-License-Identifier: AGPL-3.0-only
import { addMembership, type Database, markTemporaryPassword, type StaffRole } from '@attendra/db';
import { randomBytes } from 'node:crypto';
import type { Auth } from './auth';

/** 16 characters from 12 random bytes: over Better Auth's 12-character minimum, and short enough to read out. */
export const temporaryPassword = () => randomBytes(12).toString('base64url');

/** A new account with a password. The caller decides the membership. */
export async function createAccount(auth: Auth, m: { email: string; name: string; password: string }) {
  if (m.password.length < 12) throw new Error('passwords must be at least 12 characters');
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({ email: m.email.trim().toLowerCase(), name: m.name, emailVerified: true }, { method: 'admin' });
  await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: 'credential', accountId: user.id, password: await ctx.password.hash(m.password) });
  return user.id;
}

export async function findAccount(auth: Auth, email: string) {
  const ctx = await auth.$context;
  return (await ctx.internalAdapter.findUserByEmail(email.trim().toLowerCase()))?.user ?? null;
}

/**
 * Adds a person to an organization with a password and a role, for `pnpm add-member`
 * and the demo seed. Sign-up is off, so this and the Team page are how people get
 * in. With `temporary`, the password must be changed at first sign-in and stops
 * working after 72 hours: whoever typed it knows it. An existing account keeps its
 * own password and only gains the membership.
 */
export async function addMember(auth: Auth, db: Database, m: { email: string; name: string; password: string; orgId: string; role: StaffRole; temporary?: boolean }) {
  const found = await findAccount(auth, m.email);
  const userId = found?.id ?? await createAccount(auth, m);
  await addMembership(db, m.orgId, userId, m.role);
  if (!found && m.temporary) await markTemporaryPassword(db, userId);
  return userId;
}

/** Like addMember, and says whether the account already existed. */
export async function addMemberReport(auth: Auth, db: Database, m: Parameters<typeof addMember>[2]) {
  const existing = !!(await findAccount(auth, m.email));
  return { userId: await addMember(auth, db, m), existing };
}

export async function hashPassword(auth: Auth, password: string) {
  return (await auth.$context).password.hash(password);
}
