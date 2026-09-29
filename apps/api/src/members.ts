// SPDX-License-Identifier: AGPL-3.0-only
import { addMembership, type Database, type StaffRole } from '@attendra/db';
import type { Auth } from './auth';

/**
 * Adds a person to an organization with a password and a role. Sign-up is off, so
 * this (through scripts/add-member.ts or the demo seed) is how people get in. If the
 * email already exists, only the membership is added or its role updated.
 */
export async function addMember(auth: Auth, db: Database, m: { email: string; name: string; password: string; orgId: string; role: StaffRole }) {
  if (m.password.length < 12) throw new Error('passwords must be at least 12 characters');
  const ctx = await auth.$context;
  const email = m.email.trim().toLowerCase();
  let user = await ctx.internalAdapter.findUserByEmail(email).then((r) => r?.user ?? null);
  if (!user) {
    user = await ctx.internalAdapter.createUser({ email, name: m.name, emailVerified: true }, { method: 'admin' });
    await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: 'credential', accountId: user.id, password: await ctx.password.hash(m.password) });
  }
  await addMembership(db, m.orgId, user.id, m.role);
  return user.id;
}
