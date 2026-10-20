// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { AuthCard } from '@/components/auth/auth-card';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';
import { Input, Label } from '@/components/ui/input';
import { useMe } from '@/lib/api';
import { authClient } from '@/lib/auth-client';

/**
 * First sign-in with a temporary password: the person picks their own before
 * anything else, two-step sign-in included, so whoever read the temporary one out
 * never holds a working password for them. Also where anyone changes their own
 * password, from Your account. Every other session ends when it is saved.
 */
export default function ChangePassword() {
  const queries = useQueryClient();
  const me = useMe();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // anyone else changing theirs, from Your account
  const temporary = me.data?.user.mustChangePassword ?? true;
  const signOut = () => void authClient.signOut().finally(() => window.location.assign('/sign-in'));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (next.length < 12) return setError('Use at least 12 characters. A short sentence works well.');
    if (next !== again) return setError('The two new passwords are not the same.');
    if (next.length > 128) return setError('Use at most 128 characters.');
    setBusy(true);
    const res = await authClient.changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: true }).catch(() => null);
    setBusy(false);
    if (!res) return setError('Attendra could not be reached. Check your connection and try again.');
    if (res.error) {
      const code = (res.error as { error?: string; code?: string });
      return setError(code.error === 'same_password' ? `Choose a new password, not the ${temporary ? 'one you were given' : 'one you have now'}.`
        : code.code === 'PASSWORD_TOO_SHORT' ? 'Use at least 12 characters.'
          : code.code === 'PASSWORD_TOO_LONG' ? 'Use at most 128 characters.'
            : res.error.status === 400 || res.error.status === 401
              ? (temporary ? 'The temporary password is not right. Check it, or ask your practice manager for a new one.' : 'Your current password is not right.')
              : 'The password was not changed. Try again in a moment.');
    }
    await queries.invalidateQueries({ queryKey: ['me'] });
    // a first password: the home page sends them on (two-step setup, or where they were going)
    window.location.assign(temporary ? '/' : '/profile?changed=1');
  }

  return (
    <AuthCard title={temporary ? 'Choose your own password' : 'Change your password'} pending={me.isPending}
      subtitle={temporary ? 'You signed in with a temporary password. Replace it before you do anything else.' : 'Every other place you are signed in is signed out when you save.'}
      footer={temporary
        ? <button type="button" className="text-text-muted underline-offset-4 hover:underline" onClick={signOut}>Sign out</button>
        : <a className="font-medium text-primary underline-offset-4 hover:underline" href="/profile">Back to your account</a>}>
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="current">{temporary ? 'Temporary password' : 'Current password'}</Label>
          <Input id="current" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="next">New password</Label>
          <Input id="next" type="password" autoComplete="new-password" required minLength={12} value={next} onChange={(e) => setNext(e.target.value)} />
          <p className="text-xs text-text-muted">At least 12 characters. Only you should know it.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="again">New password again</Label>
          <Input id="again" type="password" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} />
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
        <Button type="submit" className="w-full" disabled={busy}>{busy ? 'Saving…' : 'Save my password'}</Button>
      </form>
    </AuthCard>
  );
}
