// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useEffect, useState } from 'react';
import { buttonStyles } from '@/components/ui/button';

/**
 * The one way back from a page that does not exist: the dashboard when signed in, sign-in when not. A plain request to
 * /me, not the app's query client, so a signed-out answer is only that (no "your session ended"). Until it answers, the
 * dashboard: from there a signed-out person still reaches sign-in.
 */
export function WayBack() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  useEffect(() => {
    let gone = false;
    void fetch('/api/v1/me', { credentials: 'same-origin', cache: 'no-store' })
      .then((res) => { if (!gone) setSignedIn(res.status !== 401); })
      .catch(() => { if (!gone) setSignedIn(true); });
    return () => { gone = true; };
  }, []);
  // full loads: the dashboard's home picks the clinic, and sign-in starts clean
  return signedIn === false
    ? <a href="/sign-in" className={buttonStyles({ className: 'w-full' })}>Sign in</a>
    : <a href="/" className={buttonStyles({ className: 'w-full' })} aria-busy={signedIn === null || undefined}>Back to the dashboard</a>;
}
