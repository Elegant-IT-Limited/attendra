// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { MemberList, Task, TaskList } from '@attendra/api/contracts';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Hand, MessageSquare, Phone, PhoneCall, Pill, Voicemail } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { PageHeader } from '@/components/shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Alert, Empty, Skeleton } from '@/components/ui/feedback';
import { Label, Select, Textarea } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { api, ApiFailure, useClinic } from '@/lib/api';
import { clinicTime, phone, TASK_EXPLAINED, TASK_OUTCOMES, TASK_TYPES, zoneLabel } from '@/lib/format';
import { RelativeTime } from '@/components/ui/bits';
import { cn } from '@/lib/utils';

const DETAIL_LABELS: Record<string, string> = { medication: 'Medication', pharmacy: 'Pharmacy', callback_number: 'Call back on', reason: 'Reason' };
const ICONS = { refill: Pill, callback: PhoneCall, voicemail: Voicemail, review: MessageSquare } as const;
type Who = 'everyone' | 'me' | 'unassigned';

export default function Requests() {
  const { clinicId } = useParams<{ clinicId: string }>();
  const { clinic, data: me, can, isPending } = useClinic(clinicId);
  const [status, setStatus] = useState<'open' | 'done'>('open');
  const [type, setType] = useState('');
  const [who, setWho] = useState<Who>('everyone');
  const [problem, setProblem] = useState<string | null>(null);
  const queries = useQueryClient();
  const params = new URLSearchParams({ status, ...(type ? { type } : {}), ...(who !== 'everyone' ? { assignee: who } : {}) });
  const tasks = useQuery({
    queryKey: ['tasks', clinicId, status, type, who],
    queryFn: () => api<TaskList>(`/clinics/${clinicId}/tasks?${params}`),
    enabled: can('tasks:read'),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
  // the people a manager can hand a request to
  const team = useQuery({ queryKey: ['members', clinicId], queryFn: () => api<MemberList>(`/clinics/${clinicId}/members`), enabled: can('tasks:reassign') && can('members:manage') });
  const key = ['tasks', clinicId, status, type, who];
  const toast = useToast();
  type Act = { task: Task; action: 'claim' | 'done' | 'release' | 'notes' | 'assign'; body?: Record<string, string> };
  // The screen changes at once and puts itself back if the server says no: a claim,
  // a close, an assignment or a note should never make the front desk wait.
  const act = useMutation({
    mutationFn: ({ task, action, body }: Act) =>
      api<void>(`/clinics/${clinicId}/tasks/${task.id}/${action}`, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) }),
    onMutate: async ({ task, action, body }: Act) => {
      setProblem(null);
      await queries.cancelQueries({ queryKey: key });
      const before = queries.getQueryData<TaskList>(key);
      const mine = { assigneeUserId: me?.user.id ?? null, assigneeName: me?.user.name ?? null };
      const change = (t: Task): Task | null => {
        if (t.id !== task.id) return t;
        if (action === 'claim') return { ...t, ...mine };
        if (action === 'release') return { ...t, assigneeUserId: null, assigneeName: null };
        if (action === 'assign') return { ...t, assigneeUserId: body!.userId!, assigneeName: team.data?.members.find((m) => m.userId === body!.userId)?.name ?? null };
        if (action === 'notes') return { ...t, notes: [...t.notes, { id: -Date.now(), author: me?.user.name ?? null, at: new Date().toISOString(), body: body!.body! }] };
        return null; // done: it leaves the open list
      };
      if (before) queries.setQueryData<TaskList>(key, { tasks: before.tasks.map(change).filter((t): t is Task => !!t) });
      return { before };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.before) queries.setQueryData(key, ctx.before);
      const text = e instanceof ApiFailure && e.status === 409 ? (e.body.message ?? 'Someone else has this request.') : e instanceof ApiFailure && e.body.issues?.length ? e.body.issues[0]!.message : 'That did not save. Try again.';
      setProblem(text);
      toast({ tone: 'error', message: text });
    },
    onSuccess: (_r, { task, action, body }) => {
      if (action === 'claim') toast({ tone: 'success', message: 'Claimed. It is yours now.', action: { label: 'Undo', onClick: () => act.mutate({ task, action: 'release' }) } });
      else if (action === 'done') toast({ tone: 'success', message: 'Marked done.' });
      else if (action === 'assign') toast({ tone: 'success', message: `Given to ${team.data?.members.find((m) => m.userId === body?.userId)?.name ?? 'your teammate'}.` });
      else if (action === 'notes') toast({ tone: 'success', message: 'Note added.' });
      else toast({ tone: 'success', message: 'Released. It is back in the queue.' });
    },
    onSettled: () => { void queries.invalidateQueries({ queryKey: ['tasks', clinicId] }); void queries.invalidateQueries({ queryKey: ['patient', clinicId] }); },
  });
  const tz = clinic?.timezone ?? 'UTC';

  if (isPending) return <><PageHeader title="Requests" /><Skeleton className="h-64" /></>;
  if (!can('tasks:read')) {
    return <><PageHeader title="Requests" /><Card><Empty title="Requests are for the front desk">Your role can see calls and settings, not requests, because they name patients.</Empty></Card></>;
  }
  const teammates = (team.data?.members ?? []).filter((m) => m.role !== 'viewer');

  return (
    <>
      <PageHeader title="Requests" description={<>What callers asked the team for. The assistant never approves a refill; that stays with your team. Times are {zoneLabel(tz)}.</>} />
      <Card className="mb-5 px-5 py-3">
        <dl className="grid gap-x-6 gap-y-1.5 text-sm md:grid-cols-3">
          {(['refill', 'callback', 'voicemail'] as const).map((t) => (
            <div key={t}><dt className="inline font-medium">{TASK_TYPES[t]}: </dt><dd className="inline text-text-muted">{TASK_EXPLAINED[t]}</dd></div>
          ))}
        </dl>
      </Card>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex rounded-md border border-border-strong p-0.5" role="tablist" aria-label="Status">
          {(['open', 'done'] as const).map((s) => (
            <button key={s} role="tab" aria-selected={status === s} onClick={() => setStatus(s)}
              className={cn('rounded px-3 py-1 text-sm focus-ring', status === s ? 'bg-primary text-on-primary' : 'text-text-muted hover:text-text')}>
              {s === 'open' ? 'Open' : 'Done'}
            </button>
          ))}
        </div>
        <Label htmlFor="request-type" className="sr-only">Type</Label>
        <Select id="request-type" className="h-8 w-48" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All types</option>
          {Object.entries(TASK_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <Label htmlFor="request-who" className="sr-only">Assigned to</Label>
        <Select id="request-who" className="h-8 w-44" value={who} onChange={(e) => setWho(e.target.value as Who)}>
          <option value="everyone">Anyone</option>
          <option value="me">Assigned to me</option>
          <option value="unassigned">Unassigned</option>
        </Select>
      </div>
      {problem && <Alert tone="warn" className="mb-4">{problem}</Alert>}
      {tasks.isError && <Alert tone="danger" className="mb-4">Requests did not load. They try again every 30 seconds; refresh if it keeps failing.</Alert>}
      {tasks.isPending ? <div className="grid gap-4 md:grid-cols-2"><Skeleton className="h-56" /><Skeleton className="h-56" /></div> : !tasks.data?.tasks.length ? (
        <Card><Empty title={status === 'open' ? 'Nothing waiting' : 'Nothing closed yet'}>
          {status === 'open' ? (type || who !== 'everyone' ? 'Nothing open matches these filters.' : 'New refill and callback requests from calls appear here.') : 'Requests you mark done appear here, with what came of them.'}
        </Empty></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {tasks.data.tasks.map((t) => (
            <RequestCard key={t.id} task={t} clinicId={clinicId} tz={tz} meId={me?.user.id} busy={act.isPending} teammates={teammates}
              canWork={can('tasks:work')} canReassign={can('tasks:reassign')} canOpenPatient={can('patients:read')}
              onAct={(action, body) => act.mutate({ task: t, action, body })} />
          ))}
        </div>
      )}
    </>
  );
}

function RequestCard({ task: t, clinicId, tz, meId, busy, teammates, canWork, canReassign, canOpenPatient, onAct }: {
  task: Task; clinicId: string; tz: string; meId?: string; busy: boolean; teammates: MemberList['members'];
  canWork: boolean; canReassign: boolean; canOpenPatient: boolean;
  onAct: (action: 'claim' | 'done' | 'release' | 'notes' | 'assign', body?: Record<string, string>) => void;
}) {
  const [note, setNote] = useState('');
  const [closing, setClosing] = useState(false);
  const [outcome, setOutcome] = useState(t.type === 'refill' ? 'refill_sent' : 'called_back');
  const Icon = ICONS[t.type] ?? Phone;
  const mine = t.assigneeUserId === meId;
  const heldByOther = !!t.assigneeUserId && !mine;
  const open = t.status === 'open';

  return (
    <Card className="flex flex-col" data-testid="task">
      <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary"><Icon className="size-4" /></span>
          <div className="min-w-0">
            {t.patientName && t.patientId && canOpenPatient
              ? <Link href={`/c/${clinicId}/patients/${t.patientId}`} className="block truncate font-medium hover:underline">{t.patientName}</Link>
              : <p className="truncate font-medium">{t.patientName ?? 'Caller not verified'}</p>}
            <p className="text-xs text-text-muted">{TASK_TYPES[t.type]}, {open ? <>came in <RelativeTime iso={t.createdAt} exact={clinicTime(t.createdAt, tz, 'long')} /></> : `taken ${clinicTime(t.createdAt, tz)}`}</p>
          </div>
        </div>
        {!open ? <Badge tone="ok">Done</Badge>
          : t.assigneeUserId ? <Badge tone="accent"><Hand /> {mine ? 'You have it' : `${t.assigneeName ?? 'Someone'} has it`}</Badge> : <Badge tone="warn">Unclaimed</Badge>}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-5 py-4 text-sm">
        {Object.entries(t.details).map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-text-muted">{DETAIL_LABELS[k] ?? k}</dt>
            <dd>{k === 'callback_number' ? <a className="hover:underline" href={`tel:${v}`}>{phone(v)}</a> : v}</dd>
          </div>
        ))}
        {open && t.followUp && <><dt className="text-text-muted">Suggested by the assistant</dt><dd>{t.followUp}</dd></>}
        {!open && t.outcome && <><dt className="text-text-muted">Outcome</dt><dd className="font-medium">{TASK_OUTCOMES[t.outcome]}</dd></>}
        {t.callId && <><dt className="text-text-muted">From</dt><dd><Link href={`/c/${clinicId}/calls/${t.callId}`} className="text-primary hover:underline">The call, {clinicTime(t.createdAt, tz)}</Link></dd></>}
      </dl>
      {(t.notes.length > 0 || (open && canWork)) && (
        <div className="space-y-2 border-t border-border px-5 py-3">
          {t.notes.map((n) => (
            <div key={n.id} className="rounded-md bg-surface-sunken px-3 py-2 text-sm">
              <p className="whitespace-pre-wrap">{n.body}</p>
              <p className="mt-1 text-xs text-text-muted">{n.author ?? 'A former staff member'}, {clinicTime(n.at, tz)}</p>
            </div>
          ))}
          {open && canWork && (
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (note.trim()) { onAct('notes', { body: note.trim() }); setNote(''); } }}>
              <Label htmlFor={`note-${t.id}`} className="sr-only">Add a note for the team</Label>
              <Textarea id={`note-${t.id}`} className="min-h-9 flex-1" rows={1} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note for the team" />
              <Button type="submit" size="sm" variant="outline" disabled={busy || !note.trim()}>Add note</Button>
            </form>
          )}
        </div>
      )}
      {open && canWork && (
        <div className="mt-auto flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">
          {closing ? (
            <>
              <Label htmlFor={`outcome-${t.id}`} className="sr-only">Outcome</Label>
              <Select id={`outcome-${t.id}`} className="h-8 flex-1" value={outcome} onChange={(e) => setOutcome(e.target.value)} aria-label="Outcome">
                {Object.entries(TASK_OUTCOMES).filter(([k]) => k !== 'refill_sent' || t.type === 'refill').map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
              <Button size="sm" variant="ghost" onClick={() => setClosing(false)}>Back</Button>
              <Button size="sm" disabled={busy} onClick={() => { onAct('done', { outcome }); setClosing(false); }}>Mark done</Button>
            </>
          ) : (
            <>
              {canReassign && teammates.length > 0 && (
                <>
                  <Label htmlFor={`assign-${t.id}`} className="sr-only">Assign to</Label>
                  <Select id={`assign-${t.id}`} className="mr-auto h-8 w-40" value="" disabled={busy} onChange={(e) => e.target.value && onAct('assign', { userId: e.target.value })}>
                    <option value="">Assign to…</option>
                    {teammates.filter((m) => m.userId !== t.assigneeUserId).map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
                  </Select>
                </>
              )}
              {!t.assigneeUserId && <Button size="sm" variant="outline" disabled={busy} onClick={() => onAct('claim')}>Claim</Button>}
              {t.assigneeUserId && (mine || canReassign) && <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAct('release')}>Release</Button>}
              {!heldByOther && <Button size="sm" disabled={busy} onClick={() => setClosing(true)}>Mark done</Button>}
            </>
          )}
        </div>
      )}
    </Card>
  );
}
