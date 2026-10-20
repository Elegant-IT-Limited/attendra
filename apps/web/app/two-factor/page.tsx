// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import Link from 'next/link';
import { type FormEvent, type ReactNode, useState } from 'react';
import { AuthCard } from '@/components/auth/auth-card';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';
import { Input, Label } from '@/components/ui/input';
import { authClient } from '@/lib/auth-client';

const LINK = 'font-medium text-primary underline-offset-4 hover:underline';

/**
 * The second step of signing in. A code that does not match says so; a sign-in that has
 * timed out (10 minutes) or had too many wrong codes says that instead, with the way back,
 * so nobody types correct codes into a step that can no longer accept them.
 */
function whyNot(error: { status?: number; code?: string }, backup: boolean): ReactNode {
  const startAgain = <> <Link className={LINK} href="/sign-in">Sign in again</Link>.</>;
  if (error.status === 429) return <>Too many tries. Wait 15 minutes, then{startAgain}</>;
  if (error.code === 'INVALID_TWO_FACTOR_COOKIE' || error.code === 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE' || error.status === 401) {
    return <>This sign-in has timed out or had too many tries.{startAgain}</>;
  }
  return backup ? 'That backup code did not work. Each one works once; check it and try another.'
    : 'That code did not work. Codes change every 30 seconds; enter the one your app shows now.';
}

export default function TwoFactor() {
  const [code, setCode] = useState('');
  const [backup, setBackup] = useState(false);
  const [error, setError] = useState<ReactNode | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = backup
        ? await authClient.twoFactor.verifyBackupCode({ code: code.trim() })
        : await authClient.twoFactor.verifyTotp({ code: code.replace(/\s/g, '') });
      if (res.error) { setBusy(false); return setError(whyNot(res.error as { status?: number; code?: string }, backup)); }
      // the home page sends them on: to where they were going, or their clinic
      window.location.assign('/');
    } catch {
      setBusy(false);
      setError('Attendra could not be reached. Check your connection and try again.');
    }
  }

  return (
    <AuthCard title="Two-step check" subtitle={backup ? 'Enter one of your backup codes.' : 'Enter the 6-digit code from your authenticator app.'}
      footer={<Link className={LINK} href="/sign-in">Back to sign in</Link>}>
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="code">{backup ? 'Backup code' : 'Code'}</Label>
          <Input id="code" autoFocus required inputMode={backup ? 'text' : 'numeric'} autoComplete="one-time-code" value={code}
            aria-invalid={!!error} aria-describedby={error ? 'code-error' : undefined} onChange={(e) => setCode(e.target.value)} />
        </div>
        {error && <div id="code-error"><Alert tone="danger">{error}</Alert></div>}
        <Button type="submit" className="w-full" disabled={busy}>{busy ? 'Checking…' : 'Continue'}</Button>
        <button type="button" className="text-sm text-text-muted underline-offset-4 hover:underline" onClick={() => { setBackup(!backup); setCode(''); setError(null); }}>
          {backup ? 'Use the authenticator app instead' : 'Lost your phone? Use a backup code'}
        </button>
        {backup && <p className="text-xs text-text-muted">No phone and no backup codes? Your practice owner or manager can reset your two-step sign-in on the Team page.</p>}
      </form>
    </AuthCard>
  );
}
