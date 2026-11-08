// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useProblem, useToast } from '@/components/ui/toast';
import type { AddedMember, AddResult, Health, Me, Member } from '@attendra/api/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, MailCheck, ShieldCheck, ShieldOff, UserPlus } from 'lucide-react';
import { useParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { PageHeader } from '@/components/shell';
import { Badge } from '@/components/ui/badge';
import { Avatar } from '@/components/ui/bits';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/controls';
import { Panel } from '@/components/ui/dialog';
import { Alert, Empty, Skeleton } from '@/components/ui/feedback';
import { Label, Select, Textarea } from '@/components/ui/input';
import { Table, TD, TH, THead, TRow } from '@/components/ui/table';
import { api, ApiFailure, useClinic, useMe } from '@/lib/api';
import { clinicTime, personName } from '@/lib/format';
import { pageData } from '@/lib/page-data';

// the roles, their names and what each can do come from /me: one source with the permissions the API checks
type RoleInfo = Me['roles'][number];
const message = (e: unknown) => (e instanceof ApiFailure ? (e.body.message ?? e.body.issues?.[0]?.message ?? 'That did not save.') : 'That did not save. Check your connection and try again.');

export default function Team() {
  const { clinicId } = useParams<{ clinicId: string }>();
  const { data: me, clinic, can, isPending } = useClinic(clinicId);
  const roles = me?.roles ?? [];
  const label = (role: string) => roles.find((r) => r.id === role)?.label ?? role;
  const queries = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);
  // done: a note at the bottom of the screen; not done: a dialog in the middle of it
  const toast = useToast();
  const problem = useProblem();
  const setNotice = (n: { tone: 'info' | 'warn'; text: string } | null) => {
    if (n?.tone === 'info') toast({ tone: 'success', message: n.text });
    else if (n) problem({ title: 'Not changed', message: n.text });
  };
  const members = useQuery({ ...pageData.members(clinicId), enabled: can('members:manage') });
  // invitations not answered yet: someone invited accepts or declines from their own dashboard
  const invitations = useQuery({ ...pageData.invitations(clinicId), enabled: can('members:manage') });
  const refresh = () => queries.invalidateQueries({ queryKey: ['members', clinicId] });
  const change = useMutation({
    mutationFn: ({ m, role }: { m: Member; role: string }) => api<void>(`/clinics/${clinicId}/members/${m.userId}`, { method: 'PATCH', body: JSON.stringify({ role }) }),
    onSuccess: (_r, { m, role }) => setNotice({ tone: 'info', text: role === 'owner' ? `${personName(m.name)} is now an owner, at every location. It applies to their next click.`
      : m.role === 'owner' ? `${personName(m.name)} is now ${label(role).toLowerCase()} at every location. It applies to their next click.`
        : `${personName(m.name)} is now ${label(role).toLowerCase()} at ${clinic?.name ?? 'this location'}. It applies to their next click.` }),
    onError: (e) => setNotice({ tone: 'warn', text: message(e) }),
    onSettled: refresh,
  });
  const refills = useMutation({
    mutationFn: ({ m, on }: { m: Member; on: boolean }) => api<void>(`/clinics/${clinicId}/members/${m.userId}`, { method: 'PATCH', body: JSON.stringify({ approvesRefills: on }) }),
    onSuccess: (_r, { m, on }) => {
      setNotice({ tone: 'info', text: on ? `${personName(m.name)} can now approve and decline refills.` : `${personName(m.name)} no longer approves refills.` });
      void queries.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (e) => setNotice({ tone: 'warn', text: message(e) }),
    onSettled: refresh,
  });
  const [issued, setIssued] = useState<{ name: string; email: string; password: string; role: Member['role'] } | null>(null);
  const [resetting, setResetting] = useState<Member | null>(null);
  const reset = useMutation({
    mutationFn: (m: Member) => api<AddedMember>(`/clinics/${clinicId}/members/${m.userId}/reset-password`, { method: 'POST' }),
    onSuccess: (r, m) => { setResetting(null); setIssued({ name: personName(m.name), email: m.email, password: r.temporaryPassword, role: m.role }); },
    onError: (e) => setNotice({ tone: 'warn', text: message(e) }),
    onSettled: refresh,
  });
  // a lost phone: their two-step sign-in is switched off, and they set it up again at their next sign-in
  const [unlocking, setUnlocking] = useState<Member | null>(null);
  const twoStep = useMutation({
    mutationFn: (m: Member) => api<void>(`/clinics/${clinicId}/members/${m.userId}/reset-two-factor`, { method: 'POST' }),
    onSuccess: (_r, m) => { setUnlocking(null); setNotice({ tone: 'info', text: `${personName(m.name)} can sign in with their password now, and sets up two-step sign-in on their new phone.` }); },
    onError: (e) => { setUnlocking(null); setNotice({ tone: 'warn', text: message(e) }); },
    onSettled: refresh,
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api<void>(`/clinics/${clinicId}/invitations/${id}`, { method: 'DELETE' }),
    onSuccess: () => setNotice({ tone: 'info', text: 'Invitation cancelled.' }),
    onError: (e) => setNotice({ tone: 'warn', text: message(e) }),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (m: Member) => api<void>(`/clinics/${clinicId}/members/${m.userId}`, { method: 'DELETE' }),
    onSuccess: (_r, m) => { setNotice({ tone: 'info', text: m.role === 'owner' ? `${personName(m.name)} is no longer an owner and cannot open any location of the business.` : `${personName(m.name)} can no longer open ${clinic?.name ?? 'this location'}. Their other locations stay as they are.` }); setRemoving(null); },
    onError: (e) => { setNotice({ tone: 'warn', text: message(e) }); setRemoving(null); },
    onSettled: refresh,
  });

  if (isPending) return <><PageHeader title="Team" /><Skeleton className="h-64" /></>;
  if (!can('members:manage')) return <><PageHeader title="Team" /><Card><Empty title="The team is for owners and practice managers">Ask one of them to add someone or change a role.</Empty></Card></>;
  const myRole = clinic?.role;
  const grantable = roles.filter((r) => r.id !== 'owner' || myRole === 'owner');
  const locations = me?.clinics.filter((c) => c.organizationId === clinic?.organizationId) ?? [];

  return (
    <>
      <PageHeader title="Team" description={`Who can open ${clinic?.name ?? 'this location'}, and what each person can do here.${locations.length > 1 ? ' Owners open every location; everyone else only the locations they were invited to, each with its own role.' : ''}`}
        actions={<Button onClick={() => setAdding(true)}><UserPlus /> Add people</Button>} />
      <Card>
        {members.isPending ? <div className="space-y-3 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-8" />)}</div>
          : members.isError ? <Alert tone="danger" className="m-4">The team did not load. Refresh to try again.</Alert> : (
            <Table label="Team">
              <THead><tr><TH>Name</TH><TH>Role</TH><TH><span title="A veterinarian or prescriber who may approve or decline refill requests">Approves refills</span></TH><TH className="hidden md:table-cell">Sign-in</TH><TH className="text-right"><span className="sr-only">Actions</span></TH></tr></THead>
              <tbody>
                {members.data!.members.map((m) => {
                  const locked = m.you || (m.role === 'owner' && myRole !== 'owner');
                  return (
                    <TRow key={m.userId}>
                      <TD>
                        <div className="flex items-center gap-3">
                          <Avatar name={m.name || '?'} src={m.avatarUrl} />
                          <div className="min-w-0">
                            <p className="font-medium">{personName(m.name)}{m.you && <span className="ml-2 text-xs font-normal text-text-muted">You</span>}</p>
                            <p className="text-xs text-text-muted">{m.email}{m.allLocations && locations.length > 1 ? ' · every location' : ''}</p>
                          </div>
                        </div>
                      </TD>
                      <TD>
                        {locked ? <Badge>{label(m.role)}</Badge> : (
                          <>
                            <Label htmlFor={`role-${m.userId}`} className="sr-only">Role for {personName(m.name)}</Label>
                            <Select id={`role-${m.userId}`} className="h-8 w-44" value={m.role} disabled={change.isPending} onChange={(e) => change.mutate({ m, role: e.target.value })}>
                              {grantable.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                            </Select>
                          </>
                        )}
                      </TD>
                      <TD>
                        {(m.role === 'owner' && myRole !== 'owner') || (m.you && myRole !== 'owner') ? (
                          // not theirs to change here: said in words, not a greyed-out box
                          <span className="inline-flex items-center gap-1 text-sm" title={m.you ? 'An owner changes this for you.' : 'Only an owner changes this for an owner.'}>
                            {m.approvesRefills ? <><Check className="size-4 text-primary" aria-hidden /> Yes</> : <span className="text-text-muted">No</span>}
                          </span>
                        ) : (
                          <input id={`refills-${m.userId}`} type="checkbox" className="focus-ring size-4 accent-primary disabled:opacity-50" checked={m.approvesRefills}
                            disabled={refills.isPending} aria-label={`${personName(m.name)} approves refills`} onChange={(e) => refills.mutate({ m, on: e.target.checked })} />
                        )}
                      </TD>
                      <TD className="hidden md:table-cell">
                        {m.mustChangePassword ? <span className="inline-flex items-center gap-1 text-sm text-text-muted"><KeyRound className="size-4" /> Has not chosen a password yet</span>
                          : m.twoFactorEnabled ? <span className="inline-flex items-center gap-1 text-sm"><ShieldCheck className="size-4 text-primary" /> Two-step on</span>
                            : <span className="inline-flex items-center gap-1 text-sm text-text-muted"><ShieldOff className="size-4" /> Two-step not set up yet</span>}
                      </TD>
                      <TD className="whitespace-nowrap text-right">
                        {!locked && <Button size="sm" variant="ghost" disabled={reset.isPending} onClick={() => setResetting(m)}>Reset password</Button>}
                        {!locked && m.twoFactorEnabled && <Button size="sm" variant="ghost" disabled={twoStep.isPending} onClick={() => setUnlocking(m)}>Reset two-step</Button>}
                        {!locked && <Button size="sm" variant="ghost" onClick={() => setRemoving(m)}>Remove</Button>}
                      </TD>
                    </TRow>
                  );
                })}
              </tbody>
            </Table>
          )}
      </Card>
      {!!invitations.data?.invitations.length && (
        <Card className="mt-4" data-testid="invitations">
          <Table label="Invitations">
            <THead><tr><TH>Invited</TH><TH>Role</TH><TH className="hidden md:table-cell">Sent by</TH><TH className="hidden md:table-cell">Ends</TH><TH className="text-right"><span className="sr-only">Actions</span></TH></tr></THead>
            <tbody>
              {invitations.data.invitations.map((i) => (
                <TRow key={i.id}>
                  <TD><p className="font-medium">{i.email}</p><p className="text-xs text-text-muted">Invite sent, waiting for an answer{i.allLocations || i.role === 'owner' ? ' · every location' : ''}</p></TD>
                  <TD><Badge>{label(i.role)}</Badge></TD>
                  <TD className="hidden md:table-cell">{personName(i.invitedBy)}</TD>
                  <TD className="hidden md:table-cell">{clinic ? clinicTime(i.expiresAt, clinic.timezone) : ''}</TD>
                  <TD className="text-right">
                    {(i.role !== 'owner' || myRole === 'owner') && <Button size="sm" variant="ghost" disabled={cancel.isPending} aria-label={`Cancel the invitation to ${i.email}`} onClick={() => cancel.mutate(i.id)}>Cancel</Button>}
                  </TD>
                </TRow>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      <RoleGuide roles={roles} />
      <p className="mt-3 text-xs text-text-muted">A role holds at this location only; an owner holds at every location. You cannot change your own role or remove yourself, and there is always at least one owner. Approves refills: only these people can close a refill as sent to the pharmacy, ready to pick up (which texts the caller) or not approved; tick it for your veterinarians. Every change is in the audit log.</p>

      <AddPeople clinicId={clinicId} clinicName={clinic?.name ?? 'this location'} locations={locations.length} canAllLocations={myRole === 'owner' && locations.length > 1} open={adding} onOpenChange={setAdding} roles={grantable} onAdded={refresh} />
      <Panel open={!!resetting} onOpenChange={(o) => !o && setResetting(null)} title={`Reset ${personName(resetting?.name ?? '')}'s password?`}
        description="They are signed out everywhere, their password stops working, and you get a temporary one to pass on in person."
        footer={<><Button variant="ghost" onClick={() => setResetting(null)}>Keep it</Button><Button variant="danger" loading={reset.isPending} onClick={() => resetting && reset.mutate(resetting)}>Reset password</Button></>}>
        <p className="text-base">{resetting?.email}</p>
      </Panel>
      <Panel open={!!unlocking} onOpenChange={(o) => !o && setUnlocking(null)} title={`Reset ${unlocking?.name ?? ''}'s two-step sign-in?`}
        description="For a lost or new phone. They are signed out everywhere, sign in again with their own password, and set up two-step sign-in on their phone."
        footer={<><Button variant="ghost" onClick={() => setUnlocking(null)}>Keep it</Button><Button variant="danger" loading={twoStep.isPending} onClick={() => unlocking && twoStep.mutate(unlocking)}>Reset two-step</Button></>}>
        <p className="text-base">{unlocking?.email}</p>
      </Panel>
      <Panel open={!!issued} onOpenChange={(o) => !o && setIssued(null)} title={`New temporary password for ${issued?.name ?? ''}`}
        description="They were signed out everywhere. The old password no longer works." footer={<Button onClick={() => setIssued(null)}>Done</Button>}>
        {issued && <OneTimePassword email={issued.email} password={issued.password} role={issued.role} />}
      </Panel>
      <Panel open={!!removing} onOpenChange={(o) => !o && setRemoving(null)} title={`Remove ${removing?.name ?? ''}?`}
        description={removing?.role === 'owner' ? 'They are no longer an owner and can no longer open any location of the business. Their past actions stay in the audit log.'
          : `They can no longer open ${clinic?.name ?? 'this location'}; their other locations stay as they are. Their past actions stay in the audit log.`}
        footer={<><Button variant="ghost" onClick={() => setRemoving(null)}>Keep them</Button><Button variant="danger" disabled={remove.isPending} onClick={() => removing && remove.mutate(removing)}>{remove.isPending ? 'Removing…' : 'Remove'}</Button></>}>
        <p className="text-sm">{removing?.email}</p>
      </Panel>
    </>
  );
}

type Row = { email: string; name?: string };
type Outcome = { email: string; name: string; result?: AddResult; error?: string };

/** "riley@example.com", or "Riley Stone <riley@example.com>", one per line or separated by commas. */
function parsePeople(text: string): { rows: Row[]; invalid: string[] } {
  const rows: Row[] = [];
  const invalid: string[] = [];
  for (const part of text.split(/[\n,;]+/).map((p) => p.trim()).filter(Boolean)) {
    const named = /^(.*?)\s*<\s*([^>\s]+)\s*>$/.exec(part);
    const email = (named ? named[2]! : part).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) invalid.push(part);
    else if (!rows.some((r) => r.email === email)) rows.push({ email, name: named?.[1]?.replace(/^"|"$/g, '').trim() || undefined });
  }
  return { rows, invalid };
}

/**
 * Several people at once, each with a role. Every email gets the same answer, "invite sent",
 * so the team never learns who already uses Attendra. Where the deployment cannot send
 * email, someone new gets a temporary password, shown once, to pass on in person.
 */
function AddPeople({ clinicId, clinicName, locations, canAllLocations, open, onOpenChange, roles, onAdded }: {
  clinicId: string; clinicName: string; locations: number; canAllLocations: boolean; open: boolean; onOpenChange: (o: boolean) => void; roles: RoleInfo[]; onAdded: () => void;
}) {
  const [everywhere, setEverywhere] = useState(false);
  const emailed = useQuery({ queryKey: ['health'], queryFn: () => api<Health>('/health') }).data?.passwordReset ?? false;
  const [text, setText] = useState('');
  const [roleOf, setRoleOf] = useState<Record<string, { role: Member['role']; approvesRefills: boolean }>>({});
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);
  const { rows, invalid } = parsePeople(text);
  const settings = (email: string) => roleOf[email] ?? { role: 'staff' as const, approvesRefills: false };
  const add = useMutation({
    mutationFn: async () => {
      const done: Outcome[] = [];
      // one at a time, in the order typed: each is its own change in the audit log
      for (const r of rows) {
        const { role, approvesRefills } = settings(r.email);
        const name = r.name ?? r.email.split('@')[0]!;
        try {
          done.push({ email: r.email, name, result: await api<AddResult>(`/clinics/${clinicId}/members`, { method: 'POST', body: JSON.stringify({ email: r.email, name: r.name, role, approvesRefills: role !== 'viewer' && approvesRefills, allLocations: canAllLocations && everywhere && role !== 'owner' }) }) });
        } catch (e) {
          done.push({ email: r.email, name, error: message(e) });
        }
      }
      return done;
    },
    onSuccess: (done) => { setOutcomes(done); onAdded(); },
  });
  const close = (o: boolean) => { if (!o) { setOutcomes(null); setText(''); setRoleOf({}); setEverywhere(false); add.reset(); } onOpenChange(o); };
  const submit = (e: FormEvent) => { e.preventDefault(); if (rows.length && !invalid.length) add.mutate(); };
  const failed = outcomes?.filter((o) => o.error).length ?? 0;

  return (
    <Panel open={open} onOpenChange={close} title={outcomes ? (failed ? 'Some were not added' : 'Invites sent') : 'Add people'}
      description={outcomes ? undefined : `${emailed ? 'Each person gets an email invitation to join' : 'Each person is invited'} ${clinicName}, with the role you pick.${emailed ? '' : ' Someone new to Attendra gets a temporary password, shown once, to pass on in person.'}`}
      footer={outcomes ? <Button onClick={() => close(false)}>Done</Button> : undefined}>
      {outcomes ? (
        <ul className="space-y-4" data-testid="add-results">
          {outcomes.map((o) => (
            <li key={o.email} className="space-y-2">
              <p className="flex items-center gap-2 text-base">
                {o.error ? <span className="text-danger">{o.email}: {o.error}</span>
                  : <><MailCheck className="size-4 text-primary" aria-hidden /><span><span className="font-medium">{o.email}</span>: invite sent</span></>}
              </p>
              {o.result?.temporaryPassword && <OneTimePassword email={o.email} password={o.result.temporaryPassword} role={settings(o.email).role} />}
            </li>
          ))}
        </ul>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <fieldset disabled={add.isPending} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="people-emails">Emails</Label>
              <Textarea id="people-emails" rows={4} required maxLength={5000} autoComplete="off" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)}
                aria-describedby={['people-emails-hint', invalid.length > 0 ? 'people-emails-error' : null].filter(Boolean).join(' ')} aria-invalid={invalid.length > 0 || undefined} placeholder={'riley@example.com\nSam Lee <sam@example.com>'} />
              <p id="people-emails-hint" className="text-xs text-text-muted">One per line, or separated by commas. To give someone new a name, write it before the email: Sam Lee &lt;sam@example.com&gt;.</p>
              {invalid.length > 0 && <p id="people-emails-error" className="text-sm text-danger">Not an email address: {invalid.join(', ')}</p>}
            </div>
            {rows.map((r) => {
              const s = settings(r.email);
              const set = (next: Partial<typeof s>) => setRoleOf({ ...roleOf, [r.email]: { ...s, ...next } });
              return (
                <div key={r.email} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border pt-3" data-testid="person-row">
                  <p className="min-w-0 flex-1 truncate text-sm font-medium">{r.name ? `${r.name}, ` : ''}{r.email}</p>
                  <Label htmlFor={`role-${r.email}`} className="sr-only">Role for {r.email}</Label>
                  <Select id={`role-${r.email}`} className="h-8 w-44" value={s.role} onChange={(e) => set({ role: e.target.value as Member['role'] })}>
                    {roles.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                  </Select>
                  {/* a viewer never closes requests, so the question is not asked for one */}
                  {s.role !== 'viewer' && (
                    <Checkbox id={`refills-${r.email}`} label="Approves refills" checked={s.approvesRefills} onCheckedChange={(v) => set({ approvesRefills: v })} />
                  )}
                </div>
              );
            })}
            {canAllLocations && rows.length > 0 && (
              <Checkbox id="all-locations" label={`Invite to all ${locations} locations of the business, with the same role (one Accept)`} checked={everywhere} onCheckedChange={setEverywhere} />
            )}
            {rows.length > 0 && <p className="text-xs text-text-muted">{roles.map((r) => `${r.label}: ${r.summary}`).join(' ')}</p>}
          </fieldset>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => close(false)}>Cancel</Button>
            <Button type="submit" disabled={add.isPending || !rows.length || invalid.length > 0}>{add.isPending ? 'Adding…' : rows.length > 1 ? `Add ${rows.length} people` : 'Add to the team'}</Button>
          </div>
        </form>
      )}
    </Panel>
  );
}

/** A temporary password, shown once. It must be changed at first sign-in and stops working after 72 hours. */
function OneTimePassword({ email, password, role }: { email: string; password: string; role: Member['role'] }) {
  // the new person's role decides, not yours: with ATTENDRA_TWO_FACTOR=managers only owners and practice managers must
  const twoStepRequired = useMe().data?.twoFactorRoles.includes(role) ?? true;
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-3 text-sm">
      <Alert tone="warn" title="Shown once">Pass this on in person, not by email or chat. It works for 72 hours, and they choose their own password the first time they sign in.</Alert>
      <p>Email: <span className="font-medium">{email}</span></p>
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-text-muted" aria-hidden />
        <code className="rounded-md bg-surface-sunken px-3 py-1.5 font-mono text-base tracking-wide" data-testid="temporary-password">{password}</code>
        <Button size="sm" variant="outline" onClick={() => { void navigator.clipboard?.writeText(password); setCopied(true); }}><Copy /> {copied ? 'Copied' : 'Copy'}</Button>
      </div>
      {twoStepRequired && <p className="text-text-muted">After their own password, they set up two-step sign-in with an authenticator app.</p>}
    </div>
  );
}

/** What each role can do here, generated from the permission table the API checks (/me). */
function RoleGuide({ roles }: { roles: RoleInfo[] }) {
  if (!roles.length) return null;
  return (
    <Card className="mt-4" data-testid="role-guide">
      <details className="p-4">
        <summary className="cursor-pointer text-sm font-medium">What each role can do</summary>
        <dl className="mt-3 grid gap-4 md:grid-cols-2">
          {roles.map((r) => (
            <div key={r.id} data-testid={`role-${r.id}`}>
              <dt className="font-medium">{r.label}</dt>
              <dd className="text-sm text-text-muted">
                <p>{r.summary}</p>
                <ul className="mt-1 list-disc pl-5">{r.can.map((c) => <li key={c}>{c}</li>)}{r.limits.map((l) => <li key={l}>{l}</li>)}</ul>
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </Card>
  );
}
