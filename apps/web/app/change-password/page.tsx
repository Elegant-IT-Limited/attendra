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
 * never holds a working password for them. Every other session ends when it is saved.
 */
export default function ChangePassword() {
  const queries = useQueryClient();
  const me = useMe();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (next.length < 12) return setError('Use at least 12 characters. A short sentence works well.');
    if (next !== again) return setError('The two new passwords are not the same.');
    setBusy(true);
    const res = await authClient.changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: true });
    setBusy(false);
    if (res.error) {
      const code = (res.error as { error?: string }).error;
      return setError(code === 'same_password' ? 'Choose a new password, not the one you were given.'
        : res.error.status === 400 || res.error.status === 401 ? 'The temporary password is not right. Check it, or ask your practice manager to reset it.'
          : 'The password was not changed. Try again.');
    }
    await queries.invalidateQueries({ queryKey: ['me'] });
    // two-step sign-in comes next; the home page sends them there when it is needed
    window.location.assign(me.data?.user.twoFactorEnabled || me.data?.demoMode ? '/' : '/setup-two-factor');
  }

  return (
    <AuthCard title="Choose your own password" subtitle="You signed in with a temporary password. Replace it before you do anything else.">
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="current">Temporary password</Label>
          <Input id="current" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="next">New password</Label>
          <Input id="next" type="password" autoComplete="new-password" required minLength={12} value={next} onChange={(e) => setNext(e.target.value)} />
          <p className="text-xs text-muted-foreground">At least 12 characters. Only you should know it.</p>
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
