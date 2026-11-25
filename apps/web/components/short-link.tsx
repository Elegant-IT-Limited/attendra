// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { Me } from '@attendra/api/contracts';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Empty, Skeleton } from '@/components/ui/feedback';
import { clinicToOpen } from '@/lib/last-clinic';
import { clinicPathOf } from '@/lib/short-links';

/**
 * A short address on its way: signed in, the page in the clinic last opened here (else the first); signed out, the
 * sign-in page, which comes back here after (its `next`), so the same rule picks the clinic then. A plain request to
 * /me, so someone who was never signed in is not told their session ended. No clinic yet: the dashboard's home says why.
 */
export function ShortLink({ short }: { short: string }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let gone = false;
    setFailed(false);
    void fetch('/api/v1/me', { credentials: 'same-origin', cache: 'no-store' }).then(async (res) => {
      if (gone) return;
      if (res.status === 401) return window.location.replace(`/sign-in?next=${encodeURIComponent(`/${short}`)}`);
      // a password to change or two-step sign-in to set up: the home page takes them through it first
      if (!res.ok) return res.status < 500 ? window.location.replace('/') : setFailed(true);
      const me = await res.json() as Me;
      const clinic = clinicToOpen(me.clinics);
      window.location.replace(clinic ? clinicPathOf(clinic.id, short) : '/');
    }).catch(() => { if (!gone) setFailed(true); });
    return () => { gone = true; };
  }, [short, attempt]);
  if (failed) {
    return <Empty title="Attendra did not load" action={<Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>}>The server did not answer. Try again in a moment.</Empty>;
  }
  return <div className="mx-auto mt-24 max-w-sm space-y-3" aria-busy><Skeleton className="h-6 w-40" /><Skeleton className="h-4 w-64" /></div>;
}
