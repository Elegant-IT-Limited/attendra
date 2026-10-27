// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { AvatarSaved, Me } from '@attendra/api/contracts';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { type FormEvent, Suspense, useEffect, useRef, useState } from 'react';
import { AuthCard } from '@/components/auth/auth-card';
import { Avatar } from '@/components/ui/bits';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';
import { Field, Input, Label, PasswordInput } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { api, ApiFailure, useMe } from '@/lib/api';
import { authClient } from '@/lib/auth-client';
import { avatarFrom, PICTURE_TYPES, pictureProblem } from '@/lib/avatar';
import { signOutAndLeave } from '@/lib/next';

const LINK = 'font-medium text-primary underline-offset-4 hover:underline';

const ROLE_LABEL: Record<string, string> = { owner: 'Owner', admin: 'Practice manager', staff: 'Front desk', viewer: 'Viewer' };

/**
 * Your profile: your picture and name as your team sees them, the email you sign in with and
 * your role at each clinic; then your password, and two-step sign-in (a new phone, new backup
 * codes, or turning it on or off where it is optional). Each sign-in change asks for the password first.
 */
function Profile() {
  const me = useMe();
  const queries = useQueryClient();
  const changed = useSearchParams().get('changed');
  // what the password is being asked for
  const [asking, setAsking] = useState<'phone' | 'codes' | 'off' | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [turnedOff, setTurnedOff] = useState(false);
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
      if (asking === 'phone' || asking === 'off') {
        // off: for a moment and straight into setting it up on the new phone, or for good where it is optional
        const res = await authClient.twoFactor.disable({ password });
        if (res.error) { setBusy(false); return setError(res.error.status === 429 ? 'Too many tries. Wait a minute and try again.' : 'That password is not right.'); }
        await queries.invalidateQueries({ queryKey: ['me'] });
        if (asking === 'phone') return window.location.assign('/setup-two-factor');
        setBusy(false);
        setAsking(null);
        setPassword('');
        return setTurnedOff(true);
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
    <AuthCard title="Your profile" subtitle="How your team sees you, and how you sign in." pending={me.isPending}
      footer={first ? <a className={LINK} href={`/c/${first.id}`}>Back to the dashboard</a> : undefined}>
      {changed && <Alert tone="ok">Your password is changed. You were signed out everywhere else.</Alert>}
      {me.data && <AboutYou me={me.data} />}
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
                {me.data?.twoFactorRequired === false && <Button size="sm" variant="outline" onClick={() => { setAsking('off'); setCodes(null); }}>Turn it off</Button>}
              </div>
            )}
          </>
        ) : (
          <>
            {turnedOff && <Alert tone="ok">Two-step sign-in is off. You sign in with your password only.</Alert>}
            <p className="text-sm text-text-muted">Off. A code from an authenticator app keeps your account safe even if someone learns your password.</p>
            <Link className={LINK} href="/setup-two-factor">Turn it on</Link>
          </>
        )}
        {asking && (
          <form onSubmit={confirm} className="space-y-3 rounded-md border border-border p-3">
            <div className="space-y-1.5">
              <Label htmlFor="confirm-password">{asking === 'phone' ? 'Your password, to set up a new phone' : asking === 'off' ? 'Your password, to turn two-step off' : 'Your password, for new backup codes'}</Label>
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

/** Your picture, your name, the email you sign in with, and your role at each clinic. */
function AboutYou({ me }: { me: Me }) {
  const queries = useQueryClient();
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(me.user.name);
  const [nameError, setNameError] = useState<string | null>(null);
  const [pictureError, setPictureError] = useState<string | null>(null);
  const [saving, setSaving] = useState<'name' | 'picture' | 'remove' | null>(null);
  // the name and the picture show everywhere at once: the sidebar, Team, Assign to and the requests
  const refresh = () => Promise.all([['me'], ['members'], ['assignees'], ['tasks']].map((queryKey) => queries.invalidateQueries({ queryKey })));
  const failed = (e: unknown) => (e instanceof ApiFailure ? e.body.message ?? e.body.issues?.[0]?.message : null);

  async function saveName(e: FormEvent) {
    e.preventDefault();
    const typed = name.trim();
    if (typed.length < 2 || typed.length > 80) return setNameError(typed.length < 2 ? 'Write at least 2 characters.' : 'Keep it to 80 characters.');
    setNameError(null);
    setSaving('name');
    try {
      await api<void>('/me', { method: 'PATCH', body: JSON.stringify({ name: typed }) });
      setName(typed);
      await refresh();
      toast({ tone: 'success', message: 'Saved.' });
    } catch (err) {
      setNameError(failed(err) ? `Not saved: ${failed(err)}.` : 'Not saved. Check your connection and try again.');
    } finally {
      setSaving(null);
    }
  }

  async function upload(picked: File | undefined) {
    if (file.current) file.current.value = '';
    if (!picked) return;
    const problem = pictureProblem(picked);
    if (problem) return setPictureError(problem);
    setPictureError(null);
    setSaving('picture');
    try {
      let small: Blob;
      try { small = await avatarFrom(picked); } catch { return setPictureError('That picture could not be read. Choose another JPEG, PNG or WebP.'); }
      await api<AvatarSaved>('/me/avatar', { method: 'PUT', body: small, headers: { 'content-type': small.type } });
      await refresh();
      toast({ tone: 'success', message: 'Saved.' });
    } catch (err) {
      setPictureError(failed(err) ?? 'Not saved. Check your connection and try again.');
    } finally {
      setSaving(null);
    }
  }

  async function remove() {
    setPictureError(null);
    setSaving('remove');
    try {
      await api<void>('/me/avatar', { method: 'DELETE' });
      await refresh();
      toast({ tone: 'success', message: 'Picture removed. Your initials show instead.' });
    } catch {
      setPictureError('Not removed. Check your connection and try again.');
    } finally {
      setSaving(null);
    }
  }

  return (
    <>
      <section className="space-y-2" aria-labelledby="picture-heading">
        <h2 id="picture-heading" className="text-base font-semibold">Picture</h2>
        <div className="flex items-center gap-4">
          <Avatar name={me.user.name || '?'} src={me.user.avatarUrl} size="lg" />
          <div className="flex flex-wrap gap-2">
            <input ref={file} id="picture-file" type="file" accept={PICTURE_TYPES.join(',')} className="hidden"
              onChange={(e) => void upload(e.target.files?.[0])} />
            <Button size="sm" variant="outline" loading={saving === 'picture'} disabled={!!saving} aria-describedby={pictureError ? 'picture-error' : 'picture-hint'}
              onClick={() => file.current?.click()}>Upload a picture</Button>
            {me.user.avatarUrl && <Button size="sm" variant="ghost" loading={saving === 'remove'} disabled={!!saving} onClick={() => void remove()}>Remove</Button>}
          </div>
        </div>
        {pictureError ? <p id="picture-error" className="text-xs font-medium text-danger">{pictureError}</p>
          : <p id="picture-hint" className="text-xs text-text-muted">A JPEG, PNG or WebP, up to 5 MB. It is cut to a square.</p>}
      </section>
      <form className="space-y-2" onSubmit={saveName} noValidate>
        <Field label="Your name" error={nameError} hint="As your team sees it, on requests and notes.">
          {(p) => <Input {...p} autoComplete="name" maxLength={80} value={name} onChange={(e) => { setName(e.target.value); setNameError(null); }} />}
        </Field>
        <Button type="submit" size="sm" loading={saving === 'name'} disabled={!!saving || name.trim() === me.user.name}>Save</Button>
      </form>
      <section className="space-y-1" aria-labelledby="email-heading">
        <h2 id="email-heading" className="text-base font-semibold">Email</h2>
        <p className="text-sm">Signed in as <span className="font-medium">{me.user.email}</span></p>
        <p className="text-xs text-text-muted">To use a different email, write to us.</p>
      </section>
      {me.clinics.length > 0 && (
        <section className="space-y-1" aria-labelledby="role-heading">
          <h2 id="role-heading" className="text-base font-semibold">{me.clinics.length > 1 ? 'Your roles' : 'Your role'}</h2>
          <ul className="space-y-0.5 text-sm">
            {me.clinics.map((c) => <li key={c.id}>{ROLE_LABEL[c.role] ?? c.role} at {c.name}</li>)}
          </ul>
        </section>
      )}
    </>
  );
}

export default function ProfilePage() {
  return <Suspense><Profile /></Suspense>;
}
