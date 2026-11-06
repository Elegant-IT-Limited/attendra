// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { MyInvitationList } from '@attendra/api/contracts';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { InvitationsBanner } from '@/components/invitations-banner';
import { Empty, Skeleton } from '@/components/ui/feedback';
import { Button } from '@/components/ui/button';
import { api, ApiFailure, useMe } from '@/lib/api';
import { useChanges } from '@/lib/changes';
import { authClient } from '@/lib/auth-client';
import { clinicToOpen } from '@/lib/last-clinic';
import { askForNameOnce, rememberNext, signOutAndLeave, takeNext } from '@/lib/next';

/**
 * Where a signed-in person goes: a temporary password first, then two-step sign-in where
 * it is required, then Your profile once when they have no name yet, then the page they
 * were on their way to, else the clinic they were last in (while they still belong to it),
 * else their first.
 */
export default function Home() {
  const me = useMe();
  const router = useRouter();
  const first = me.data ? clinicToOpen(me.data.clinics) : undefined;
  // a temporary password comes first, then two-step sign-in, then the clinic
  const mustChange = me.data?.user.mustChangePassword;
  const needsTwoStep = !!me.data && me.data.twoFactorRequired && !me.data.user.twoFactorEnabled;
  useEffect(() => {
    if (!me.data) return;
    if (mustChange) return router.replace('/change-password');
    if (needsTwoStep) return router.replace('/setup-two-factor');
    // the page they were going to, if it was theirs (account pages are another app behind /account: a full load)
    const next = takeNext(me.data.user.id);
    // an invitation they came for is answered first: it is what gives them a clinic
    if (next?.startsWith('/invite/')) return window.location.assign(next);
    // someone added by email alone writes their name first, once; the page they were going to keeps
    if (me.data.user.nameMissing && askForNameOnce()) {
      if (next) rememberNext(next);
      return router.replace('/profile');
    }
    if (next) window.location.assign(next);
    else if (first) router.replace(`/c/${first.id}`);
  }, [me.data, mustChange, needsTwoStep, first, router]);
  // a sign-in problem goes to the sign-in page on its own; anything else would leave the skeleton up for good
  if (me.isError && !(me.error instanceof ApiFailure && me.error.status < 500)) {
    return <Empty title="Attendra did not load" action={<Button variant="outline" onClick={() => void me.refetch()}>Try again</Button>}>The server did not answer. Try again in a moment.</Empty>;
  }
  // a login with no clinic is never a dead end: its invitations are here to accept, or it opens a clinic of its own
  if (me.data && !first && !mustChange && !needsTwoStep) return <NoClinicYet newClinicUrl={me.data.newClinicUrl} />;
  return <div className="mx-auto mt-24 max-w-sm space-y-3"><Skeleton className="h-6 w-40" /><Skeleton className="h-4 w-64" /></div>;
}

/**
 * A login with no clinic: the invitations waiting for it, to accept here; with none, a way
 * to open a clinic of its own (the hosted service asks for an invite code) and what to ask a
 * practice owner for. Never only "you have no clinic".
 */
function NoClinicYet({ newClinicUrl }: { newClinicUrl: string | null }) {
  // an invitation sent now appears here at once, and accepted in another tab, this one moves on
  useChanges(null);
  const invitations = useQuery({ queryKey: ['me', 'invitations'], queryFn: () => api<MyInvitationList>('/me/invitations'), staleTime: 60_000 });
  const waiting = invitations.data?.invitations.length ?? 0;
  const signOut = <Button variant="ghost" onClick={() => signOutAndLeave(() => authClient.signOut())}>Sign out</Button>;
  if (invitations.isPending) return <div className="mx-auto mt-24 max-w-sm space-y-3"><Skeleton className="h-6 w-40" /><Skeleton className="h-4 w-64" /></div>;
  return (
    <div className="mx-auto mt-16 max-w-xl space-y-4 px-4" data-testid="no-clinic">
      {waiting > 0 ? (
        <>
          <h1 className="text-xl font-semibold">{waiting === 1 ? 'You have an invitation' : `You have ${waiting} invitations`}</h1>
          <p className="text-text-muted">Accept to open the clinic. You can answer each one separately.</p>
          <InvitationsBanner inline />
        </>
      ) : (
        <Empty title="No clinic yet"
          action={<div className="flex flex-wrap justify-center gap-2">
            {newClinicUrl && <Button onClick={() => window.location.assign(newClinicUrl)}>Open a new clinic</Button>}
            {signOut}
          </div>}>
          {newClinicUrl
            ? 'Joining a clinic\'s team? Ask its owner or practice manager to invite this email address: the invitation shows up here. Starting your own? Open a new clinic with your invite code.'
            : 'Ask the clinic\'s owner or practice manager to invite this email address. The invitation shows up here, and in your email.'}
        </Empty>
      )}
      {waiting > 0 && <div className="flex justify-center">{signOut}</div>}
    </div>
  );
}
