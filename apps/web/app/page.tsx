// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Empty, Skeleton } from '@/components/ui/feedback';
import { Button } from '@/components/ui/button';
import { ApiFailure, useMe } from '@/lib/api';
import { authClient } from '@/lib/auth-client';
import { takeNext } from '@/lib/next';

/**
 * Where a signed-in person goes: a temporary password first, then two-step sign-in where
 * it is required, then the page they were on their way to, else their first clinic.
 */
export default function Home() {
  const me = useMe();
  const router = useRouter();
  const first = me.data?.clinics[0];
  // a temporary password comes first, then two-step sign-in, then the clinic
  const mustChange = me.data?.user.mustChangePassword;
  const needsTwoStep = !!me.data && me.data.twoFactorRequired && !me.data.user.twoFactorEnabled;
  useEffect(() => {
    if (!me.data) return;
    if (mustChange) return router.replace('/change-password');
    if (needsTwoStep) return router.replace('/setup-two-factor');
    // the page they were going to (account pages are another app behind /account: a full load)
    const next = takeNext();
    if (next) window.location.assign(next);
    else if (first) router.replace(`/c/${first.id}`);
  }, [me.data, mustChange, needsTwoStep, first, router]);
  // a sign-in problem goes to the sign-in page on its own; anything else would leave the skeleton up for good
  if (me.isError && !(me.error instanceof ApiFailure && me.error.status < 500)) {
    return <Empty title="Attendra did not load" action={<Button variant="outline" onClick={() => void me.refetch()}>Try again</Button>}>The server did not answer. Try again in a moment.</Empty>;
  }
  if (me.data && !first) {
    return (
      <Empty title="No clinic yet" action={<Button variant="outline" onClick={() => void authClient.signOut().finally(() => window.location.assign('/sign-in'))}>Sign out</Button>}>
        Your account is not a member of any clinic. Ask your practice owner to add you.
      </Empty>
    );
  }
  return <div className="mx-auto mt-24 max-w-sm space-y-3"><Skeleton className="h-6 w-40" /><Skeleton className="h-4 w-64" /></div>;
}
