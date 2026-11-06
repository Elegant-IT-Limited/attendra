// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { AcceptedInvitation, InvitationView, Me } from '@attendra/api/contracts';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AuthCard } from '@/components/auth/auth-card';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';
import { api, ApiFailure, saveProblem } from '@/lib/api';
import { authClient } from '@/lib/auth-client';
import { invitationLine } from '@/lib/invitations';
import { markSignedOut, rememberNext } from '@/lib/next';

const LINK = 'font-medium text-primary underline-offset-4 hover:underline';

type Loaded = { invitation: InvitationView; me: Me };

/**
 * The page an invitation email opens: "Maple Street invited you as Front desk. Accept or
 * Decline". Signed out, it signs the person in first (a new person chooses a password from
 * the same email) and comes back here; with a temporary password or two-step sign-in still
 * to set up, those come first, then back here. Signed in as another address, it says so and
 * offers to sign out. A cancelled, lapsed or answered invitation says which, never a blank
 * clinic page. Accepting opens that clinic.
 *
 * Plain requests, not the shared query client: a signed-out answer here means "sign in for
 * this invitation", not "your session ended".
 */
export default function InvitePage() {
  const { id } = useParams<{ id: string }>();
  const here = `/invite/${encodeURIComponent(id)}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState<'accept' | 'decline' | 'out' | null>(null);
  const [declined, setDeclined] = useState(false);

  const load = useCallback(async () => {
    setFailed(null);
    try {
      const [invitation, me] = await Promise.all([api<InvitationView>(`/me/invitations/${encodeURIComponent(id)}`), api<Me>('/me')]);
      setLoaded({ invitation, me });
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 401) {
        rememberNext(here);
        return window.location.replace(`/sign-in?invited=1&next=${encodeURIComponent(here)}`);
      }
      if (e instanceof ApiFailure && e.body.error === 'password_change_required') { rememberNext(here); return window.location.replace('/change-password'); }
      if (e instanceof ApiFailure && e.body.error === 'two_factor_required') { rememberNext(here); return window.location.replace('/setup-two-factor'); }
      setFailed(saveProblem(e).replace(/^Not saved: /, ''));
    }
  }, [id, here]);
  useEffect(() => { void load(); }, [load]);

  async function answer(accept: boolean) {
    setBusy(accept ? 'accept' : 'decline');
    try {
      const r = await api<AcceptedInvitation | undefined>(`/me/invitations/${encodeURIComponent(id)}/${accept ? 'accept' : 'decline'}`, { method: 'POST' });
      // a full load: the clinic switcher and the menu read who you are afresh
      if (accept && r?.clinicId) return window.location.assign(`/c/${r.clinicId}`);
      setDeclined(true);
    } catch (e) {
      setBusy(null);
      // answered or withdrawn meanwhile: show what it is now
      if (e instanceof ApiFailure && e.status === 404) return void load();
      setFailed(saveProblem(e).replace(/^Not saved/, 'Not answered'));
    }
  }

  async function signOutForThis() {
    setBusy('out');
    markSignedOut();
    await authClient.signOut().catch(() => {});
    rememberNext(here);
    window.location.assign(`/sign-in?invited=1&next=${encodeURIComponent(here)}`);
  }

  if (!loaded) {
    return (
      <AuthCard title="Your invitation" pending={!failed}>
        {failed && <Alert tone="danger">{failed}</Alert>}
        {failed && <Button className="w-full" variant="outline" onClick={() => void load()}>Try again</Button>}
      </AuthCard>
    );
  }
  const { invitation: inv, me } = loaded;
  const home = <a className={LINK} href="/">Go to your clinics</a>;

  if (!('clinicId' in inv) && inv.state === 'not_found') {
    return <AuthCard title="Invitation not found" footer={home}><p>This link does not match an invitation. Check that it is the whole link from the email, or ask the clinic to send it again.</p></AuthCard>;
  }
  if (!('clinicId' in inv)) {
    return (
      <AuthCard title="This invitation is for another address" footer={home}>
        <p data-testid="invite-other-address">You are signed in as <strong>{me.user.email}</strong>. The invitation was sent to another email address: sign in with that one to answer it.</p>
        <Button className="w-full" disabled={busy === 'out'} aria-busy={busy === 'out'} onClick={() => void signOutForThis()}>Sign out and sign in with the invited address</Button>
      </AuthCard>
    );
  }
  const line = invitationLine(inv, me.roles);
  const role = me.roles.find((r) => r.id === inv.role);
  if (declined) return <AuthCard title="Invitation declined" footer={home}><p>You said no to {inv.clinicName}. If you change your mind, ask them to send a new invitation.</p></AuthCard>;
  if (inv.state === 'accepted') {
    const open = me.clinics.some((c) => c.id === inv.clinicId);
    return (
      <AuthCard title="Already accepted" footer={home}>
        <p>You accepted this invitation from {inv.clinicName}.</p>
        {open && <Button className="w-full" onClick={() => window.location.assign(`/c/${inv.clinicId}`)}>Open {inv.clinicName}</Button>}
      </AuthCard>
    );
  }
  if (inv.state === 'declined') return <AuthCard title="Invitation declined" footer={home}><p>You said no to this invitation from {inv.clinicName}. Ask them to send a new one if you change your mind.</p></AuthCard>;
  if (inv.state === 'canceled') return <AuthCard title="Invitation cancelled" footer={home}><p data-testid="invite-closed">{inv.clinicName} cancelled this invitation. Ask them to send a new one if you still need access.</p></AuthCard>;
  if (inv.state === 'expired') return <AuthCard title="Invitation lapsed" footer={home}><p data-testid="invite-closed">Invitations last 7 days, and this one has lapsed. Ask {inv.clinicName} to send a new one.</p></AuthCard>;

  return (
    <AuthCard title="Your invitation" footer={home}>
      <p className="text-lg font-medium" data-testid="invite-line">{line}</p>
      {role && (
        <div className="space-y-1 text-base">
          <p className="text-text-muted">{role.summary}</p>
          <ul className="list-disc space-y-0.5 pl-5 text-text-muted">
            {role.can.map((c) => <li key={c}>{c}</li>)}
            {role.limits.map((l) => <li key={l}>{l}</li>)}
          </ul>
        </div>
      )}
      {failed && <Alert tone="danger">{failed}</Alert>}
      <div className="flex gap-2">
        <Button className="flex-1" disabled={!!busy} aria-busy={busy === 'accept'} onClick={() => void answer(true)}>{busy === 'accept' ? 'Accepting…' : 'Accept'}</Button>
        <Button className="flex-1" variant="outline" disabled={!!busy} aria-busy={busy === 'decline'} onClick={() => void answer(false)}>Decline</Button>
      </div>
    </AuthCard>
  );
}
