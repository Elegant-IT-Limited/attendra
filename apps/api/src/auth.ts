// SPDX-License-Identifier: AGPL-3.0-only
import { authModels, type Database } from '@attendra/db';
import type { Logger } from '@attendra/observability';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization, twoFactor } from 'better-auth/plugins';
import { createAccessControl } from 'better-auth/plugins/access';
import { adminAc, defaultStatements, memberAc, ownerAc } from 'better-auth/plugins/organization/access';
import type { MailRequest } from './mail-hook';

// Better Auth manages people, sessions and member admin; our own table in
// access.ts decides what each role may see. These roles only carry Better Auth's
// member-management rights, so the plugin accepts our four role names.
const ac = createAccessControl(defaultStatements);
const roles = {
  owner: ac.newRole(ownerAc.statements),
  admin: ac.newRole(adminAc.statements),
  staff: ac.newRole(memberAc.statements),
  viewer: ac.newRole(memberAc.statements),
};

export interface AuthOptions {
  publicUrl: string;
  secret: string;
  /** Tests switch the rate limiter off; everything else keeps it on. */
  rateLimit?: boolean;
  /** Better Auth's own messages go through the redacting logger, message text only. */
  log?: Logger;
  /** Sends a "forgot password" email (the hosting layer's mail hook). Without it, people ask their manager for a reset. */
  passwordReset?: (m: MailRequest) => Promise<void>;
}

export function createAuth(db: Database, opts: AuthOptions) {
  return betterAuth({
    appName: 'Attendra',
    telemetry: { enabled: false },
    // The client address comes from Fastify (which applies TRUST_PROXY) as a single
    // x-forwarded-for value, set by the handler in app.ts; nothing the browser sends.
    advanced: { cookiePrefix: 'attendra', ipAddress: { ipAddressHeaders: ['x-forwarded-for'] } },
    logger: {
      level: 'warn',
      log: (level, message) => opts.log?.[level]({}, `auth: ${message}`),
    },
    baseURL: opts.publicUrl,
    basePath: '/api/auth',
    secret: opts.secret,
    trustedOrigins: [opts.publicUrl],
    database: drizzleAdapter(db, { provider: 'pg', schema: authModels }),
    user: { modelName: 'auth_users' },
    account: { modelName: 'auth_accounts' },
    verification: { modelName: 'auth_verifications' },
    // A front-desk shift, not a month: a session ends 12 hours after sign-in, however
    // busy it is. The dashboard also signs out after 15 idle minutes.
    session: { modelName: 'auth_sessions', expiresIn: 60 * 60 * 12, disableSessionRefresh: true },
    // People are added on the Team page or with scripts/add-member.ts, never by sign-up.
    // Accounts made here are confirmed already; one opened by self-serve sign-up waits until its address is confirmed.
    emailAndPassword: {
      enabled: true, disableSignUp: true, minPasswordLength: 12, requireEmailVerification: true,
      // "Forgot password": a one-hour link to /reset-password, emailed by the hosting layer.
      // A reset ends every session; two-step sign-in still applies at the next sign-in.
      ...(opts.passwordReset ? {
        resetPasswordTokenExpiresIn: 60 * 60,
        revokeSessionsOnPasswordReset: true,
        // not awaited: an answer that waited for the email would be slower for an address with an account
        sendResetPassword: async ({ user, token }: { user: { email: string; name: string; emailVerified: boolean }; token: string }) => {
          void opts.passwordReset!({ type: 'password_reset', email: user.email, name: user.name, emailVerified: user.emailVerified, url: `${opts.publicUrl}/reset-password?token=${encodeURIComponent(token)}` });
        },
      } : {}),
    },
    // a few reset emails an hour per address asking (the hosting layer also limits them per recipient), on top of the general limit
    rateLimit: { enabled: opts.rateLimit ?? true, window: 60, max: 30, customRules: { '/request-password-reset': { window: 3600, max: 5 }, '/reset-password': { window: 600, max: 10 } } },
    plugins: [
      organization({
        ac, roles, creatorRole: 'owner', allowUserToCreateOrganization: false,
        schema: { organization: { modelName: 'organizations' }, member: { modelName: 'memberships' }, invitation: { modelName: 'invitations' } },
      }),
      twoFactor({ issuer: 'Attendra', schema: { twoFactor: { modelName: 'auth_two_factors' } } }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
