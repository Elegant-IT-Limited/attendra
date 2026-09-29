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
  useEffect(() => { if (me.data?.user.mustChangePassword) router.replace('/change-password'); }, [me.data, router]);
  const qr = useMemo(() => (setup ? renderSVG(setup.totpURI, { border: 1 }) : null), [setup]);
  const secret = setup ? new URL(setup.totpURI).searchParams.get('secret') : null;

  async function start(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await authClient.twoFactor.enable({ password });
    if (res.error || !res.data) return setError(res.error?.status === 400 && /password/i.test(res.error.message ?? '') ? 'That password is not right.' : `Setup could not start: ${res.error?.message ?? 'try again'}.`);
    if (!('totpURI' in res.data)) return setError('This server is not set up for authenticator apps.');
    setSetup({ totpURI: res.data.totpURI, backupCodes: res.data.backupCodes });
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await authClient.twoFactor.verifyTotp({ code: code.replace(/\s/g, '') });
    if (res.error) return setError('That code did not match. Check the time on your phone and try the current code.');
    await queries.invalidateQueries({ queryKey: ['me'] });
    router.replace('/');
  }

  if (!setup) {
    return (
      <AuthCard title="Turn on two-step sign-in" subtitle="Everyone who can see patient calls signs in with a password and a code from an authenticator app.">
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
    <AuthCard title="Scan this code" subtitle="Use Google Authenticator, 1Password, Authy or any TOTP app.">
      {/* renderSVG builds the markup from our own otpauth URI; no user content goes in */}
      <div className="mx-auto w-48 rounded-lg bg-white p-2 [&_svg]:h-auto [&_svg]:w-full" dangerouslySetInnerHTML={{ __html: qr! }} />
      <p className="text-center text-xs text-muted-foreground">Can&apos;t scan? Enter <code className="font-mono break-all">{secret}</code></p>
      <Alert tone="warn" title="Save your backup codes">
        <p>Each works once if you lose your phone. Keep them somewhere safe, not on this computer.</p>
        <ul className="grid grid-cols-2 gap-x-4 pt-1 font-mono text-xs">{setup.backupCodes.map((c) => <li key={c}>{c}</li>)}</ul>
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
