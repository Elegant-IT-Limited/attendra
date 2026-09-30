// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useQuery } from '@tanstack/react-query';
import type { Health } from '@attendra/api/contracts';
import { useSearchParams } from 'next/navigation';
import { type FormEvent, Suspense, useState } from 'react';
import { AuthCard } from '@/components/auth/auth-card';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';
import { Input, Label } from '@/components/ui/input';
import { api } from '@/lib/api';
import { authClient } from '@/lib/auth-client';

function SignIn() {
  const health = useQuery({ queryKey: ['health'], queryFn: () => api<Health>('/health') });
  const idle = useSearchParams().get('idle');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // the demo login being signed in with, so its button shows the loading state
  const [demo, setDemo] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    await signIn(email, password);
  }

  async function signIn(withEmail: string, withPassword: string, demoLogin: string | null = null) {
    setBusy(true);
    setDemo(demoLogin);
    setError(null);
    const res = await authClient.signIn.email({ email: withEmail, password: withPassword });
    if (res.error) {
      setBusy(false);
      setDemo(null);
      const code = (res.error as { error?: string }).error;
      return setError(res.error.status === 429 ? 'Too many sign-in attempts. Wait a few seconds and try again.'
        : code === 'temporary_password_expired' ? 'This temporary password has expired. Ask your practice manager to reset it.'
          : 'That email and password do not match.');
    }
    // with two-factor on, the client plugin has already moved us to /two-factor;
    // otherwise a full load, so nothing cached from an earlier session survives
    if (!(res.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) window.location.assign('/');
  }

  return (
    // shown once the API has said whether this is a demo, so the demo box never pushes the form down
    <AuthCard title="Sign in" subtitle="The front desk for your AI receptionist." pending={health.isPending}>
      {idle && <Alert>You were signed out after 15 minutes without activity.</Alert>}
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
          <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
        <Button type="submit" className="w-full" disabled={busy}>{busy && !demo ? 'Signing in…' : 'Sign in'}</Button>
      </form>
    </AuthCard>
  );
}

// useSearchParams needs a Suspense boundary when the page is prerendered
export default function SignInPage() {
  return <Suspense><SignIn /></Suspense>;
}
