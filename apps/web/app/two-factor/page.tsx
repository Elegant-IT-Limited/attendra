// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { type FormEvent, useState } from 'react';
import { AuthCard } from '@/components/auth/auth-card';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';
import { Input, Label } from '@/components/ui/input';
import { authClient } from '@/lib/auth-client';

export default function TwoFactor() {
  const [code, setCode] = useState('');
  const [backup, setBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const res = backup
      ? await authClient.twoFactor.verifyBackupCode({ code: code.trim() })
      : await authClient.twoFactor.verifyTotp({ code: code.replace(/\s/g, '') });
    if (res.error) return setError('That code did not work. Codes change every 30 seconds; try the current one.');
    window.location.assign('/');
  }

  return (
    <AuthCard title="Two-step check" subtitle={backup ? 'Enter one of your backup codes.' : 'Enter the 6-digit code from your authenticator app.'}>
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="code">{backup ? 'Backup code' : 'Code'}</Label>
          <Input id="code" autoFocus required inputMode={backup ? 'text' : 'numeric'} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
        <Button type="submit" className="w-full">Continue</Button>
        <button type="button" className="text-sm text-text-muted underline-offset-4 hover:underline" onClick={() => { setBackup(!backup); setCode(''); }}>
          {backup ? 'Use the authenticator app instead' : 'Lost your phone? Use a backup code'}
        </button>
      </form>
    </AuthCard>
  );
}
