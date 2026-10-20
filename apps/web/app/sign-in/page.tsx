// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useQuery } from '@tanstack/react-query';
import type { Health } from '@attendra/api/contracts';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { type FormEvent, type ReactNode, Suspense, useEffect, useState } from 'react';
import { AuthCard } from '@/components/auth/auth-card';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';
import { Input, Label, PasswordInput } from '@/components/ui/input';
import { api } from '@/lib/api';
import { authClient } from '@/lib/auth-client';
import { rememberNext, safeNext } from '@/lib/next';

const LINK = 'font-medium text-primary underline-offset-4 hover:underline';

/** What went wrong, in words a clinic owner can act on. Only a refusal of the details blames them. */
function whyNot(error: { status?: number; code?: string; error?: string } | null, resendUrl?: string): ReactNode {
  if (!error) return 'Attendra could not be reached. Check your connection and try again.';
  if (error.status === 429) return 'Too many sign-in attempts. Wait a few seconds and try again.';
  if (error.error === 'temporary_password_expired') return 'This temporary password has expired. Ask your practice owner or manager to give you a new one on the Team page.';
  if (error.code === 'EMAIL_NOT_VERIFIED') {
    return <>Confirm your email address first: open the link we sent when you signed up.{resendUrl && <> Cannot find it? <a className={LINK} href={resendUrl}>Send a new link</a>.</>}</>;
  }
  if (error.status === 401 || error.status === 400 || error.status === 403) return 'That email and password do not match. Check them and try again.';
  return 'Attendra could not be reached. Try again in a moment.';
}

function SignIn() {
  const health = useQuery({ queryKey: ['health'], queryFn: () => api<Health>('/health') });
  const params = useSearchParams();
  const idle = params.get('idle');
  const expired = params.get('expired');
  const next = params.get('next');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<ReactNode | null>(null);
  const [busy, setBusy] = useState(false);
  // the demo login being signed in with, so its button shows the loading state
  const [demo, setDemo] = useState<string | null>(null);

  // already signed in (in another tab, or before this page was reloaded): straight on to where they
  // were going. A plain request, not the app's query client, so a signed-out answer is just that.
  useEffect(() => {
    let gone = false;
    void fetch('/api/v1/me', { credentials: 'same-origin', cache: 'no-store' }).then((res) => {
      if (!gone && res.ok) window.location.replace(safeNext(next) ?? '/');
    }).catch(() => { /* offline: the form stays */ });
    return () => { gone = true; };
  }, [next]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    await signIn(email, password);
  }

  async function signIn(withEmail: string, withPassword: string, demoLogin: string | null = null) {
    setBusy(true);
    setDemo(demoLogin);
    setError(null);
    // every step after this one (a code, a new password, two-step setup) ends where they were going
    rememberNext(next);
    try {
      const res = await authClient.signIn.email({ email: withEmail.trim(), password: withPassword });
      if (res.error) {
        setBusy(false);
        setDemo(null);
        return setError(whyNot(res.error as { status?: number; code?: string; error?: string }, health.data?.resendUrl));
      }
      // with two-factor on, the client plugin has already moved us to /two-factor;
      // otherwise a full load, so nothing cached from an earlier session survives
      if (!(res.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) window.location.assign('/');
    } catch {
      setBusy(false);
      setDemo(null);
      setError(whyNot(null));
    }
  }

  return (
    // shown once the API has said whether this is a demo, so the demo box never pushes the form down
    <AuthCard title="Sign in" subtitle="The front desk for your AI receptionist." pending={health.isPending}
      footer={health.data?.signupUrl ? <>New to Attendra? <a className={LINK} href={health.data.signupUrl}>Start your free trial</a></> : undefined}>
      {idle && <Alert>You were signed out after a while without activity.</Alert>}
      {expired && !idle && <Alert>You were signed out. Sign in again to carry on where you were.</Alert>}
      {health.data?.demoSignIn ? (
        <Alert title="Demo clinic, synthetic patients">
          <p>Click a login to sign in with it. The password, for the form below, is <code className="font-mono">{health.data.demoSignIn.password}</code>.</p>
          <div className="flex flex-wrap gap-2 pt-1">
            {health.data.demoSignIn.logins.map((l) => (
              <Button key={l.email} type="button" size="sm" variant="outline" disabled={busy} aria-busy={demo === l.email}
                onClick={() => { setEmail(l.email); setPassword(health.data!.demoSignIn!.password); void signIn(l.email, health.data!.demoSignIn!.password, l.email); }}>
                {demo === l.email ? 'Signing in…' : l.label}
              </Button>
            ))}
          </div>
        </Alert>
      ) : health.data?.demoMode ? (
        <Alert title="Demo clinic, synthetic patients">Sign in with the demo login you were given.</Alert>
      ) : null}
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoComplete="username" required value={email} aria-invalid={!!error} aria-describedby={error ? 'sign-in-error' : undefined} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <Label htmlFor="password">Password</Label>
            {health.data?.passwordReset && <Link className="text-sm text-primary underline-offset-4 hover:underline" href="/forgot-password">Forgot your password?</Link>}
          </div>
          <PasswordInput id="password" autoComplete="current-password" required value={password} aria-invalid={!!error} aria-describedby={error ? 'sign-in-error' : undefined} onChange={(e) => setPassword(e.target.value)} />
          {health.data && !health.data.passwordReset && !health.data.demoMode && (
            <p className="text-xs text-text-muted">Forgot your password? Your practice owner or manager can give you a new one on the Team page.</p>
          )}
        </div>
        {error && <div id="sign-in-error"><Alert tone="danger">{error}</Alert></div>}
        <Button type="submit" className="w-full" disabled={busy}>{busy && !demo ? 'Signing in…' : 'Sign in'}</Button>
      </form>
    </AuthCard>
  );
}

// useSearchParams needs a Suspense boundary when the page is prerendered
export default function SignInPage() {
  return <Suspense><SignIn /></Suspense>;
}
