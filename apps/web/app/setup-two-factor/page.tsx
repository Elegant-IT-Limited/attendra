// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { renderSVG } from 'uqr';
import { AuthCard } from '@/components/auth/auth-card';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';
import { Input, Label } from '@/components/ui/input';
import { useMe } from '@/lib/api';
import { authClient } from '@/lib/auth-client';
import { signOutAndLeave } from '@/lib/next';

/**
 * First sign-in: staff turn on two-factor before they can see any patient data.
 * Step one confirms the password and returns the secret; step two proves the
 * authenticator app has it.
 */
export default function SetupTwoFactor() {
  const router = useRouter();
  const queries = useQueryClient();
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState<{ totpURI: string; backupCodes: string[] } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  // two-step setup waits until a temporary password has been replaced; the API refuses it before then
  const me = useMe();
  // set up already (a second tab, a back button): on to where they were going
  useEffect(() => {
    if (me.data?.user.mustChangePassword) router.replace('/change-password');
    else if (me.data?.user.twoFactorEnabled && !setup) window.location.assign('/');
  }, [me.data, router, setup]);
  const [copied, setCopied] = useState<'key' | 'codes' | null>(null);
  const copy = (what: 'key' | 'codes', text: string) => { void navigator.clipboard?.writeText(text).then(() => setCopied(what), () => {}); };
  const signOut = () => signOutAndLeave(() => authClient.signOut());
  const qr = useMemo(() => (setup ? renderSVG(setup.totpURI, { border: 1 }) : null), [setup]);
  const secret = setup ? new URL(setup.totpURI).searchParams.get('secret') : null;
  // turned on by choice, from Your account: a way back; when it is required, only signing out
  const optional = me.data?.twoFactorRequired === false;
  const footer = optional
    ? <a className="font-medium text-primary underline-offset-4 hover:underline" href="/profile">Back to your account</a>
    : <button type="button" className="text-text-muted underline-offset-4 hover:underline" onClick={signOut}>Sign out</button>;

  async function start(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await authClient.twoFactor.enable({ password }).catch(() => null);
    if (!res) return setError('Attendra could not be reached. Check your connection and try again.');
    if (res.error && /already enabled/i.test(res.error.message ?? '')) return window.location.assign('/');
    if (res.error || !res.data) return setError(res.error?.status === 400 || res.error?.status === 401 ? 'That password is not right.' : 'Two-step sign-in could not be set up just now. Try again in a moment.');
    if (!('totpURI' in res.data)) return setError('This server is not set up for authenticator apps.');
    setSetup({ totpURI: res.data.totpURI, backupCodes: res.data.backupCodes });
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await authClient.twoFactor.verifyTotp({ code: code.replace(/\s/g, '') }).catch(() => null);
    if (!res) return setError('Attendra could not be reached. Check your connection and try again.');
    if (res.error) return setError('That code did not match. Check the time on your phone and try the current code.');
    await queries.invalidateQueries({ queryKey: ['me'] });
    // the home page sends them on: to where they were going, or their clinic
    window.location.assign('/');
  }

  if (!setup) {
    return (
      <AuthCard title="Turn on two-step sign-in" subtitle={optional ? 'A code from an authenticator app keeps your account safe even if someone learns your password.' : 'Everyone who can see patient calls signs in with a password and a code from an authenticator app.'}
        footer={footer}>
        <form onSubmit={start} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="password">Confirm your password</Label>
            <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {error && <Alert tone="danger">{error}</Alert>}
          <Button type="submit" className="w-full">Continue</Button>
        </form>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Scan this code" subtitle="Use Google Authenticator, 1Password, Authy or any TOTP app."
      footer={footer}>
      {/* renderSVG builds the markup from our own otpauth URI; no user content goes in */}
      <div className="mx-auto w-48 rounded-lg bg-white p-2 [&_svg]:h-auto [&_svg]:w-full" dangerouslySetInnerHTML={{ __html: qr! }} />
      {/* on the phone itself there is nothing to scan: the link opens the authenticator app */}
      <p className="text-center text-sm md:hidden"><a className="font-medium text-primary underline-offset-4 hover:underline" href={setup.totpURI}>Open in your authenticator app</a></p>
      <p className="text-center text-xs text-text-muted">
        Can&apos;t scan? Enter <code className="font-mono break-all">{secret}</code>{' '}
        <button type="button" className="font-medium text-primary underline-offset-4 hover:underline" onClick={() => copy('key', secret ?? '')}>{copied === 'key' ? 'Copied' : 'Copy'}</button>
      </p>
      <Alert tone="warn" title="Save your backup codes">
        <p>Each works once if you lose your phone. Keep them somewhere safe, not on this computer.</p>
        <ul className="grid grid-cols-2 gap-x-4 pt-1 font-mono text-xs">{setup.backupCodes.map((c) => <li key={c}>{c}</li>)}</ul>
        <button type="button" className="pt-1 text-sm font-medium text-primary underline-offset-4 hover:underline" onClick={() => copy('codes', setup.backupCodes.join('\n'))}>{copied === 'codes' ? 'Copied' : 'Copy the codes'}</button>
      </Alert>
      <form onSubmit={verify} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="code">Code from the app</Label>
          <Input id="code" autoFocus required inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
        <Button type="submit" className="w-full">Turn on and continue</Button>
      </form>
    </AuthCard>
  );
}
