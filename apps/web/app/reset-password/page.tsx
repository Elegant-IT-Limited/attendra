// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { type FormEvent, type ReactNode, Suspense, useState } from 'react';
import { AuthCard } from '@/components/auth/auth-card';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';
import { Label, PasswordInput } from '@/components/ui/input';

const LINK = 'font-medium text-primary underline-offset-4 hover:underline';

/** The link from a "forgot password" email: a new password, then sign in with it. Every session ends. */
function ResetPassword() {
  const token = useSearchParams().get('token') ?? '';
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<ReactNode | null>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const expired = <>This link has expired or was already used. <Link className={LINK} href="/forgot-password">Ask for a new one</Link>.</>;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (next.length < 12) return setError('Use at least 12 characters. A short sentence works well.');
    if (next.length > 128) return setError('Use at most 128 characters.');
    if (next !== again) return setError('The two passwords are not the same.');
    setState('busy');
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, newPassword: next }),
      });
      if (res.ok) return setState('done');
      const body = await res.json().catch(() => ({})) as { code?: string };
      setState('idle');
      setError(res.status === 429 ? 'Too many tries. Wait a few minutes and try again.'
        : body.code === 'PASSWORD_TOO_SHORT' ? 'Use at least 12 characters.'
          : body.code === 'PASSWORD_TOO_LONG' ? 'Use at most 128 characters.'
            : res.status === 400 ? expired : 'The password was not changed. Try again in a moment.');
    } catch {
      setState('idle');
      setError('Attendra could not be reached. Check your connection and try again.');
    }
  }

  if (!token) {
    return <AuthCard title="Choose a new password" footer={<Link className={LINK} href="/sign-in">Back to sign in</Link>}><Alert tone="danger">{expired}</Alert></AuthCard>;
  }
  if (state === 'done') {
    return (
      <AuthCard title="Your password is changed" subtitle="You were signed out everywhere. Sign in with your new password.">
        <Button className="w-full" onClick={() => window.location.assign('/sign-in')}>Sign in</Button>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Choose a new password" subtitle="At least 12 characters. Only you should know it." footer={<Link className={LINK} href="/sign-in">Back to sign in</Link>}>
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="next">New password</Label>
          <PasswordInput id="next" autoComplete="new-password" required minLength={12} autoFocus value={next} onChange={(e) => setNext(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="again">New password again</Label>
          <PasswordInput id="again" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} />
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
        <Button type="submit" className="w-full" disabled={state === 'busy'}>{state === 'busy' ? 'Saving…' : 'Save my new password'}</Button>
      </form>
    </AuthCard>
  );
}

// useSearchParams needs a Suspense boundary when the page is prerendered
export default function ResetPasswordPage() {
  return <Suspense><ResetPassword /></Suspense>;
}
