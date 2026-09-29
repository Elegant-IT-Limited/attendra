// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { AddedMember, Member, MemberList } from '@attendra/api/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, ShieldCheck, ShieldOff, UserPlus } from 'lucide-react';
import { useParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { PageHeader } from '@/components/shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Panel } from '@/components/ui/dialog';
import { Alert, Empty, Skeleton } from '@/components/ui/feedback';
import { Input, Label, Select } from '@/components/ui/input';
import { Table, TD, TH, THead, TRow } from '@/components/ui/table';
import { api, ApiFailure, useClinic } from '@/lib/api';

const ROLES: { id: Member['role']; label: string; detail: string }[] = [
  { id: 'owner', label: 'Owner', detail: 'Everything, including other owners.' },
  { id: 'admin', label: 'Practice manager', detail: 'Settings, the audit log, the team, and handing out requests.' },
  { id: 'staff', label: 'Front desk', detail: 'Calls, the schedule, patients and requests.' },
  { id: 'viewer', label: 'Viewer', detail: 'The call list and settings, with no patient details.' },
];
const label = (role: string) => ROLES.find((r) => r.id === role)?.label ?? role;
const message = (e: unknown) => (e instanceof ApiFailure ? (e.body.message ?? e.body.issues?.[0]?.message ?? 'That did not save.') : 'That did not save. Check your connection and try again.');

export default function Team() {
  const { clinicId } = useParams<{ clinicId: string }>();
  const { clinic, can, isPending } = useClinic(clinicId);
  const queries = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [notice, setNotice] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);
  const members = useQuery({ queryKey: ['members', clinicId], queryFn: () => api<MemberList>(`/clinics/${clinicId}/members`), enabled: can('members:manage') });
  const refresh = () => queries.invalidateQueries({ queryKey: ['members', clinicId] });
  const change = useMutation({
    mutationFn: ({ m, role }: { m: Member; role: string }) => api<void>(`/clinics/${clinicId}/members/${m.userId}`, { method: 'PATCH', body: JSON.stringify({ role }) }),
    onMutate: () => setNotice(null),
    onSuccess: (_r, { m, role }) => setNotice({ tone: 'info', text: `${m.name} is now ${label(role).toLowerCase()}. It applies to their next click.` }),
    onError: (e) => setNotice({ tone: 'warn', text: message(e) }),
    onSettled: refresh,
  });
  const [issued, setIssued] = useState<{ name: string; email: string; password: string } | null>(null);
  const reset = useMutation({
    mutationFn: (m: Member) => api<AddedMember>(`/clinics/${clinicId}/members/${m.userId}/reset-password`, { method: 'POST' }),
    onMutate: () => setNotice(null),
    onSuccess: (r, m) => setIssued({ name: m.name, email: m.email, password: r.temporaryPassword }),
    onError: (e) => setNotice({ tone: 'warn', text: message(e) }),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (m: Member) => api<void>(`/clinics/${clinicId}/members/${m.userId}`, { method: 'DELETE' }),
    onMutate: () => setNotice(null),
    onSuccess: (_r, m) => { setNotice({ tone: 'info', text: `${m.name} is off the team and signed out.` }); setRemoving(null); },
    onError: (e) => { setNotice({ tone: 'warn', text: message(e) }); setRemoving(null); },
    onSettled: refresh,
  });

  if (isPending) return <><PageHeader title="Team" /><Skeleton className="h-64" /></>;
  if (!can('members:manage')) return <><PageHeader title="Team" /><Card><Empty title="The team is for owners and practice managers">Ask one of them to add someone or change a role.</Empty></Card></>;
  const myRole = clinic?.role;
  const grantable = ROLES.filter((r) => r.id !== 'owner' || myRole === 'owner');

  return (
    <>
      <PageHeader title="Team" description="Who can sign in to this clinic, and what each person can do."
        actions={<Button onClick={() => setAdding(true)}><UserPlus /> Add a person</Button>} />
      {notice && <Alert tone={notice.tone} className="mb-4">{notice.text}</Alert>}
      <Card>
        {members.isPending ? <div className="space-y-3 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-8" />)}</div>
          : members.isError ? <Alert tone="danger" className="m-4">The team did not load. Refresh to try again.</Alert> : (
            <Table>
              <THead><tr><TH>Name</TH><TH>Role</TH><TH className="hidden md:table-cell">Sign-in</TH><TH className="text-right"><span className="sr-only">Actions</span></TH></tr></THead>
              <tbody>
                {members.data!.members.map((m) => {
                  const locked = m.you || (m.role === 'owner' && myRole !== 'owner');
                  return (
                    <TRow key={m.userId}>
                      <TD>
                        <p className="font-medium">{m.name}{m.you && <span className="ml-2 text-xs font-normal text-muted-foreground">You</span>}</p>
                        <p className="text-xs text-muted-foreground">{m.email}</p>
                      </TD>
                      <TD>
                        {locked ? <Badge>{label(m.role)}</Badge> : (
                          <>
                            <Label htmlFor={`role-${m.userId}`} className="sr-only">Role for {m.name}</Label>
                            <Select id={`role-${m.userId}`} className="h-8 w-44" value={m.role} disabled={change.isPending} onChange={(e) => change.mutate({ m, role: e.target.value })}>
                              {grantable.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                            </Select>
                          </>
                        )}
                      </TD>
                      <TD className="hidden md:table-cell">
                        {m.mustChangePassword ? <span className="inline-flex items-center gap-1 text-sm text-muted-foreground"><KeyRound className="size-4" /> Has not chosen a password yet</span>
                          : m.twoFactorEnabled ? <span className="inline-flex items-center gap-1 text-sm"><ShieldCheck className="size-4 text-primary" /> Two-step on</span>
                            : <span className="inline-flex items-center gap-1 text-sm text-muted-foreground"><ShieldOff className="size-4" /> Two-step not set up yet</span>}
                      </TD>
                      <TD className="whitespace-nowrap text-right">
                        {!locked && <Button size="sm" variant="ghost" disabled={reset.isPending} onClick={() => reset.mutate(m)}>Reset password</Button>}
                        {!locked && <Button size="sm" variant="ghost" onClick={() => setRemoving(m)}>Remove</Button>}
                      </TD>
                    </TRow>
                  );
                })}
              </tbody>
            </Table>
          )}
      </Card>
      <p className="mt-3 text-xs text-muted-foreground">You cannot change your own role or remove yourself, and there is always at least one owner. Every change is in the audit log.</p>

      <AddPerson clinicId={clinicId} open={adding} onOpenChange={setAdding} roles={grantable} onAdded={refresh} />
      <Panel open={!!issued} onOpenChange={(o) => !o && setIssued(null)} title={`New temporary password for ${issued?.name ?? ''}`}
        description="They were signed out everywhere. The old password no longer works." footer={<Button onClick={() => setIssued(null)}>Done</Button>}>
        {issued && <OneTimePassword email={issued.email} password={issued.password} />}
      </Panel>
      <Panel open={!!removing} onOpenChange={(o) => !o && setRemoving(null)} title={`Remove ${removing?.name ?? ''}?`}
        description="They are signed out straight away and can no longer open this clinic. Their past actions stay in the audit log."
        footer={<><Button variant="ghost" onClick={() => setRemoving(null)}>Keep them</Button><Button variant="danger" disabled={remove.isPending} onClick={() => removing && remove.mutate(removing)}>{remove.isPending ? 'Removing…' : 'Remove'}</Button></>}>
        <p className="text-sm">{removing?.email}</p>
      </Panel>
    </>
  );
}

function AddPerson({ clinicId, open, onOpenChange, roles, onAdded }: { clinicId: string; open: boolean; onOpenChange: (o: boolean) => void; roles: typeof ROLES; onAdded: () => void }) {
  const [form, setForm] = useState({ name: '', email: '', role: 'staff' });
  const [added, setAdded] = useState<(AddedMember & { name: string; email: string }) | null>(null);
  const add = useMutation({
    mutationFn: () => api<AddedMember>(`/clinics/${clinicId}/members`, { method: 'POST', body: JSON.stringify(form) }),
    onSuccess: (r) => { setAdded({ ...r, name: form.name, email: form.email }); onAdded(); },
  });
  const close = (o: boolean) => { if (!o) { setAdded(null); setForm({ name: '', email: '', role: 'staff' }); add.reset(); } onOpenChange(o); };
  const submit = (e: FormEvent) => { e.preventDefault(); add.mutate(); };

  return (
    <Panel open={open} onOpenChange={close} title={added ? `${added.name} is on the team` : 'Add a person'}
      description={added ? undefined : 'They sign in with their email and a temporary password, then set up two-step sign-in.'}
      footer={added ? <Button onClick={() => close(false)}>Done</Button> : undefined}>
      {added ? (
        <OneTimePassword email={added.email} password={added.temporaryPassword} />
      ) : (
        <form onSubmit={submit} className="space-y-4">
          {add.isError && <Alert tone="warn">{message(add.error)}</Alert>}
          <fieldset disabled={add.isPending} className="space-y-4">
            <div className="space-y-1.5"><Label htmlFor="member-name">Name</Label><Input id="member-name" required maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div className="space-y-1.5"><Label htmlFor="member-email">Email</Label><Input id="member-email" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
            <div className="space-y-1.5">
              <Label htmlFor="member-role">Role</Label>
              <Select id="member-role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                {roles.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </Select>
              <p className="text-xs text-muted-foreground">{ROLES.find((r) => r.id === form.role)?.detail}</p>
            </div>
          </fieldset>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => close(false)}>Cancel</Button>
            <Button type="submit" disabled={add.isPending}>{add.isPending ? 'Adding…' : 'Add to the team'}</Button>
          </div>
        </form>
      )}
    </Panel>
  );
}

/** A temporary password, shown once. It must be changed at first sign-in and stops working after 72 hours. */
function OneTimePassword({ email, password }: { email: string; password: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-3 text-sm">
      <Alert tone="warn" title="Shown once">Pass this on in person, not by email or chat. It works for 72 hours, and they choose their own password the first time they sign in.</Alert>
      <p>Email: <span className="font-medium">{email}</span></p>
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-muted-foreground" aria-hidden />
        <code className="rounded-md bg-muted px-3 py-1.5 font-mono text-base tracking-wide" data-testid="temporary-password">{password}</code>
        <Button size="sm" variant="outline" onClick={() => { void navigator.clipboard?.writeText(password); setCopied(true); }}><Copy /> {copied ? 'Copied' : 'Copy'}</Button>
      </div>
      <p className="text-muted-foreground">After their own password, they set up two-step sign-in with an authenticator app.</p>
    </div>
  );
}
