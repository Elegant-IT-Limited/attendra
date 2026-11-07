// SPDX-License-Identifier: AGPL-3.0-only
import type { Logger } from '@attendra/observability';
import { signRequest } from './http/signature';

/** What the engine asks the hosting layer to email: it has no mailer of its own. */
export type MailRequest =
  | { type: 'password_reset'; email: string; name: string; emailVerified: boolean; url: string }
  /**
   * "Maple Street invited you to its team as Front desk": `url` opens the invitation's own
   * page (/invite/<id>), where the person accepts or declines after signing in.
   * `setPasswordUrl` (a /reset-password link that works until the invitation lapses, and
   * returns to the invitation) is there only for an account with no password yet: one
   * made by this invitation. `name` is empty when nobody gave one: the email then greets with "Hi,"
   * only, never with the start of the address.
   */
  | { type: 'team_invitation'; email: string; name: string; clinicName: string; role: string; expiresAt: string; url: string; setPasswordUrl?: string };

export type Mailer = (m: MailRequest) => Promise<void>;

/**
 * Posts an email request to the hosting layer (ATTENDRA_MAIL_HOOK_URL), with the same bearer
 * token the hosting layer uses for provisioning, and signed with it (http/signature.ts), so
 * the hosting layer can stop taking the bearer alone. The address, the name and a
 * link (and for an invitation, the clinic's name and the role) only: nothing else about the person. A failure is logged, never shown, so
 * the answer to "forgot password" is the same whether the address has an account or not.
 */
export function mailHook(url: string, token: string, log?: Logger): Mailer {
  return async (m: MailRequest) => {
    try {
      const body = JSON.stringify(m);
      const at = new URL(url);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...signRequest(token, { method: 'POST', path: at.pathname + at.search, body }) },
        body, signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) log?.warn({ status: res.status, type: m.type }, 'mail hook refused the request');
    } catch (err) {
      log?.warn({ type: m.type, name: (err as Error).name }, 'mail hook could not be reached');
    }
  };
}
