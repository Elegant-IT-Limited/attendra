// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { type FormEvent, Suspense, useEffect, useState } from 'react';
import { AuthCard } from '@/components/auth/auth-card';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';
import { Label, PasswordInput } from '@/components/ui/input';
import { useMe } from '@/lib/api';
import { authClient } from '@/lib/auth-client';
import { signOutAndLeave } from '@/lib/next';

const LINK = 'font-medium text-primary underline-offset-4 hover:underline';

/**
 * Your account: your password, and two-step sign-in (a new phone, new backup codes, or
 * turning it on where it is optional). Each change asks for the password first.
 */
function Profile() {
  const me = useMe();
  const queries = useQueryClient();
  const changed = useSearchParams().get('changed');
  // what the password is being asked for
  const [asking, setAsking] = useState<'phone' | 'codes' | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const user = me.data?.user;
  const first = me.data?.clinics[0];
  // a temporary password is changed before anything else
  useEffect(() => { if (me.data?.user.mustChangePassword) window.location.assign('/change-password'); }, [me.data]);
  const signOut = () => signOutAndLeave(() => authClient.signOut());

  async function confirm(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (asking === 'phone') {
        // off for a moment, then straight into setting it up on the new phone
        const res = await authClient.twoFactor.disable({ password });
        if (res.error) { setBusy(false); return setError(res.error.status === 429 ? 'Too many tries. Wait a minute and try again.' : 'That password is not right.'); }
        await queries.invalidateQueries({ queryKey: ['me'] });
        return window.location.assign('/setup-two-factor');
      }
      const res = await authClient.twoFactor.generateBackupCodes({ password });
      setBusy(false);
      if (res.error || !res.data) return setError(res.error?.status === 429 ? 'Too many tries. Wait a minute and try again.' : 'That password is not right.');
      setCodes(res.data.backupCodes);
      setAsking(null);
      setPassword('');
    } catch {
      setBusy(false);
      setError('Attendra could not be reached. Check your connection and try again.');
    }
  }

  return (
    <AuthCard title="Your account" subtitle={user ? `${user.name}, ${user.email}` : undefined} pending={me.isPending}
      footer={first ? <a className={LINK} href={`/c/${first.id}`}>Back to the dashboard</a> : undefined}>
      {changed && <Alert tone="ok">Your password is changed. You were signed out everywhere else.</Alert>}
      <section className="space-y-2">
        <h2 className="text-base font-semibold">Password</h2>
        <Link className={LINK} href="/change-password">Change your password</Link>
      </section>
      <section className="space-y-2">
        <h2 className="text-base font-semibold">Two-step sign-in</h2>
        {user?.twoFactorEnabled ? (
          <>
            <p className="text-sm text-text-muted">On: you sign in with your password and a code from your authenticator app.</p>
            {!asking && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => { setAsking('phone'); setCodes(null); }}>Use a new phone</Button>
                <Button size="sm" variant="outline" onClick={() => { setAsking('codes'); setCodes(null); }}>New backup codes</Button>
              </div>
            )}
          </>
        ) : (
          <>
            <p className="text-sm text-text-muted">Off. A code from an authenticator app keeps your account safe even if someone learns your password.</p>
            <Link className={LINK} href="/setup-two-factor">Turn it on</Link>
          </>
        )}
        {asking && (
          <form onSubmit={confirm} className="space-y-3 rounded-md border border-border p-3">
            <div className="space-y-1.5">
              <Label htmlFor="confirm-password">{asking === 'phone' ? 'Your password, to set up a new phone' : 'Your password, for new backup codes'}</Label>
              <PasswordInput id="confirm-password" autoComplete="current-password" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
              {asking === 'codes' && <p className="text-xs text-text-muted">Your old backup codes stop working.</p>}
            </div>
            {error && <Alert tone="danger">{error}</Alert>}
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={busy}>{busy ? 'Checking…' : 'Continue'}</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => { setAsking(null); setPassword(''); setError(null); }}>Cancel</Button>
            </div>
          </form>
        )}
        {codes && (
          <Alert tone="warn" title="Your new backup codes">
            <p>Each works once if you lose your phone. Keep them somewhere safe; the old ones no longer work.</p>
            <ul className="grid grid-cols-2 gap-x-4 pt-1 font-mono text-xs">{codes.map((c) => <li key={c}>{c}</li>)}</ul>
          </Alert>
        )}
      </section>
      <Button variant="outline" className="w-full" onClick={signOut}>Sign out</Button>
    </AuthCard>
  );
}

export default function ProfilePage() {
  return <Suspense><Profile /></Suspense>;
}
