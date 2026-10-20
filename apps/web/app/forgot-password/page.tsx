// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { Health } from '@attendra/api/contracts';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { AuthCard } from '@/components/auth/auth-card';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';
import { Input, Label } from '@/components/ui/input';
import { api } from '@/lib/api';

const LINK = 'font-medium text-primary underline-offset-4 hover:underline';

/**
 * "Forgot your password?": a link by email that works for an hour. The answer is the same
 * whether or not the address has an account, so nobody learns who uses Attendra here.
 */
export default function ForgotPassword() {
  const health = useQuery({ queryKey: ['health'], queryFn: () => api<Health>('/health') });
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'sent' | 'off' | 'limited' | 'failed'>('idle');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setState('busy');
    try {
      const res = await fetch('/api/auth/request-password-reset', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: email.trim() }),
      });
      setState(res.ok ? 'sent' : res.status === 429 ? 'limited' : res.status === 400 ? 'off' : 'failed');
    } catch {
      setState('failed');
    }
  }

  const off = state === 'off' || (health.data && !health.data.passwordReset);
  return (
    <AuthCard title="Forgot your password?" subtitle={off ? undefined : 'We email you a link to choose a new one.'} pending={health.isPending}
      footer={<Link className={LINK} href="/sign-in">Back to sign in</Link>}>
      {off ? (
        <Alert>Your practice owner or manager can give you a new password on the Team page. If you are the owner, write to Attendra support.</Alert>
      ) : state === 'sent' ? (
        <Alert tone="ok" title="Check your email">
          If {email.trim()} has an account, a link to choose a new password is on its way. It works for an hour. Nothing there? Check your spam folder, or try again in a few minutes.
        </Alert>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email">Your email</Label>
            <Input id="email" type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          {state === 'limited' && <Alert tone="danger">Too many requests for now. Wait a while and try again.</Alert>}
          {state === 'failed' && <Alert tone="danger">Attendra could not be reached. Check your connection and try again.</Alert>}
          <Button type="submit" className="w-full" disabled={state === 'busy'}>{state === 'busy' ? 'Sending…' : 'Email me a link'}</Button>
        </form>
      )}
    </AuthCard>
  );
}
