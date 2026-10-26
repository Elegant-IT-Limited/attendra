// SPDX-License-Identifier: AGPL-3.0-only
import { addMembership, type Database, markTemporaryPassword, type StaffRole } from '@attendra/db';
import { randomBytes } from 'node:crypto';
import type { Auth } from './auth';

/** The roles in the words the dashboard uses, for emails. */
export const ROLE_LABEL: Record<StaffRole, string> = { owner: 'Owner', admin: 'Practice manager', staff: 'Front desk', viewer: 'Viewer' };

/** 16 characters from 12 random bytes: over Better Auth's 12-character minimum, and short enough to read out. */
export const temporaryPassword = () => randomBytes(12).toString('base64url');

/** A new account with a password. The caller decides the membership. */
/** `emailVerified: false` is for self-serve sign-up: the account cannot sign in until the address is confirmed. */
export async function createAccount(auth: Auth, m: { email: string; name: string; password: string; emailVerified?: boolean }) {
  if (m.password.length < 12) throw new Error('passwords must be at least 12 characters');
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({ email: m.email.trim().toLowerCase(), name: m.name, emailVerified: m.emailVerified ?? true }, { method: 'admin' });
  await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: 'credential', accountId: user.id, password: await ctx.password.hash(m.password) });
  return user.id;
}

/** Deletes an account made a moment ago whose membership could not be added, so adding the person again works. */
export async function deleteNewAccount(auth: Auth, userId: string) {
  const ctx = await auth.$context;
  await ctx.internalAdapter.deleteAccounts(userId);
  await ctx.internalAdapter.deleteUser(userId);
}

/**
 * An account for someone invited by email, with no password at all: nobody can sign in to
 * it until the person sets one through the link in their invitation.
 */
export async function createInvitedAccount(auth: Auth, m: { email: string; name: string }) {
  const ctx = await auth.$context;
  return (await ctx.internalAdapter.createUser({ email: m.email.trim().toLowerCase(), name: m.name, emailVerified: true }, { method: 'admin' })).id;
}

/** Whether the account has a password of its own yet (one made by an invitation has none until the person sets it). */
export async function hasPassword(auth: Auth, userId: string) {
  const ctx = await auth.$context;
  return !!(await ctx.internalAdapter.findCredentialAccount(userId))?.password;
}

/** A link to /reset-password that sets the account's password, working until `expiresAt`: the same kind "Forgot password" emails. */
export async function setPasswordLink(auth: Auth, publicUrl: string, userId: string, expiresAt: Date) {
  const ctx = await auth.$context;
  const token = randomBytes(24).toString('base64url');
  await ctx.internalAdapter.createVerificationValue({ identifier: `reset-password:${token}`, value: userId, expiresAt });
  return `${publicUrl}/reset-password?token=${encodeURIComponent(token)}`;
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
export async function addMember(auth: Auth, db: Database, m: { email: string; name: string; password: string; orgId: string; role: StaffRole; temporary?: boolean; approvesRefills?: boolean }) {
  const found = await findAccount(auth, m.email);
  const userId = found?.id ?? await createAccount(auth, m);
  await addMembership(db, m.orgId, userId, m.role, m.approvesRefills);
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
