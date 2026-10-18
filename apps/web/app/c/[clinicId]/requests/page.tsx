// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { MemberList, Task, TaskList } from '@attendra/api/contracts';
import { type CustomField, localDateOf, multiValues } from '@attendra/core';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, Flag, Hand, Info, Phone, PhoneCall, Pill, Search, SlidersHorizontal, UserCheck, Voicemail, X } from 'lucide-react';
import Link from 'next/link';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { PageHeader } from '@/components/shell';
import { TextStatus } from '@/components/calls/text-status';
import { CustomFieldsForm, shownValue } from '@/components/patients/custom-fields';
import { Badge } from '@/components/ui/badge';
import { Button, buttonStyles } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Alert, Empty, Skeleton } from '@/components/ui/feedback';
import { useSettled } from '@/components/patients/patient-search';
import { Input, Label, Select, Textarea } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { api, ApiFailure, useClinic, useClinicConfig } from '@/lib/api';
import { clinicTime, dayTitle, phone, TASK_OUTCOMES, TASK_TYPES, taskExplained, taskType, zoneLabel } from '@/lib/format';
import { useTerms } from '@/lib/terms';
import { RelativeTime } from '@/components/ui/bits';
import { cn } from '@/lib/utils';

const DETAIL_LABELS: Record<string, string> = {
  topic: 'Topic',
  medication: 'Medication', pharmacy: 'Pharmacy', callback_number: 'Call back on', reason: 'Reason',
  first_name: 'First name', last_name: 'Last name', date_of_birth: 'Date of birth', gender: 'Gender', phone: 'Phone', guardian_name: 'Parent or guardian', possible_duplicate: 'Worth a look',
  suggested: 'Suggested next step',
  pet_name: 'Pet', species: 'Kind of animal', sex: 'Sex', owner_name: 'Owner', date_of_birth_note: 'Birthday note',
};
/** Sent to the pharmacy, ready to pick up, or not approved: only members marked as approving refills on the Team page. */
const DECISIONS = new Set(['refill_sent', 'refill_ready', 'refill_declined']);
const ICONS = { refill: Pill, callback: PhoneCall, voicemail: Voicemail, review: UserCheck, follow_up: Flag } as const;
type Who = 'everyone' | 'me' | 'unassigned';
/** What an action sends: the teammate, a note, an outcome, or the urgency and due day. */
type ActBody = { userId?: string; body?: string; outcome?: string; urgent?: boolean; dueOn?: string | null };

export default function RequestsPage() {
  return <Suspense fallback={<Skeleton className="h-64" />}><Requests /></Suspense>;
}

function Requests() {
  const { clinicId } = useParams<{ clinicId: string }>();
  const { clinic, data: me, can, isPending } = useClinic(clinicId);
  const terms = useTerms(clinicId);
  // the tab is in the address, so a link can open a closed request (?status=done)
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const status: 'open' | 'done' = search.get('status') === 'done' ? 'done' : 'open';
  const setStatus = (s: 'open' | 'done') => {
    const q = new URLSearchParams(search.toString());
    if (s === 'done') q.set('status', 'done'); else q.delete('status');
    router.replace(q.size ? `${pathname}?${q}` : pathname, { scroll: false });
  };
  // a link can open the list on one type: the refill queue is ?type=refill
  const [type, setType] = useState(() => { const t = search.get('type') ?? ''; return Object.hasOwn(TASK_TYPES, t) ? t : ''; });
  const [who, setWho] = useState<Who>('everyone');
  // what is typed narrows the list as it is typed; the dates are the clinic's own days
  const [text, setText] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // one of the clinic's own request fields, a dropdown or yes-or-no, and its value
  const [fieldFilter, setFieldFilter] = useState<{ id: string; value: string }>({ id: '', value: '' });
  const config = useClinicConfig(clinicId);
  const requestFields = config.data?.requestFields ?? [];
  const filterable = requestFields.filter((f) => f.kind === 'choice' || f.kind === 'multi' || f.kind === 'yesno');
  const filterField = filterable.find((f) => f.id === fieldFilter.id);
  const q = useSettled(text.trim());
  const queries = useQueryClient();
  // a POST body: what is typed can be a name or a phone number, and never goes in an address
  const filters = { status, ...(type ? { type } : {}), ...(who !== 'everyone' ? { assignee: who } : {}), q, ...(from ? { from } : {}), ...(to ? { to } : {}) };
  const filtered = !!(type || who !== 'everyone' || q || from || to || fieldFilter.value);
  const tasks = useQuery({
    queryKey: ['tasks', clinicId, status, type, who, q, from, to],
    queryFn: () => api<TaskList>(`/clinics/${clinicId}/tasks/search`, { method: 'POST', body: JSON.stringify(filters) }),
    enabled: can('tasks:read'),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
  // the people a manager can hand a request to
  const team = useQuery({ queryKey: ['members', clinicId], queryFn: () => api<MemberList>(`/clinics/${clinicId}/members`), enabled: can('tasks:reassign') && can('members:manage') });
  const key = ['tasks', clinicId, status, type, who, q, from, to];
  const toast = useToast();
  type Act = { task: Task; action: 'claim' | 'done' | 'release' | 'notes' | 'assign' | 'plan'; body?: ActBody };
  // The screen changes at once and puts itself back if the server says no: a claim,
  // a close, an assignment or a note should never make the front desk wait.
  const act = useMutation({
    mutationFn: ({ task, action, body }: Act) =>
      api<void>(`/clinics/${clinicId}/tasks/${task.id}/${action}`, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) }),
    onMutate: async ({ task, action, body }: Act) => {
      await queries.cancelQueries({ queryKey: key });
      const before = queries.getQueryData<TaskList>(key);
      const mine = { assigneeUserId: me?.user.id ?? null, assigneeName: me?.user.name ?? null };
      const change = (t: Task): Task | null => {
        if (t.id !== task.id) return t;
        if (action === 'claim') return { ...t, ...mine };
        if (action === 'release') return { ...t, assigneeUserId: null, assigneeName: null };
        if (action === 'assign') return { ...t, assigneeUserId: body!.userId!, assigneeName: team.data?.members.find((m) => m.userId === body!.userId)?.name ?? null };
        if (action === 'plan') return { ...t, ...(body!.urgent !== undefined ? { urgent: body!.urgent } : {}), ...(body!.dueOn !== undefined ? { dueOn: body!.dueOn } : {}) };
        if (action === 'notes') return { ...t, notes: [...t.notes, { id: -Date.now(), author: me?.user.name ?? null, at: new Date().toISOString(), body: body!.body! }] };
        return null; // done: it leaves the open list
      };
      if (before) queries.setQueryData<TaskList>(key, { tasks: before.tasks.map(change).filter((t): t is Task => !!t) });
      return { before };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.before) queries.setQueryData(key, ctx.before);
      const text = e instanceof ApiFailure && e.status === 409 ? (e.body.message ?? 'Someone else has this request.') : e instanceof ApiFailure && e.body.issues?.length ? e.body.issues[0]!.message : 'That did not save. Try again.';
      // said once, in the toast, which stays until it is read
      toast({ tone: 'error', message: text });
    },
    onSuccess: (_r, { task, action, body }) => {
      if (action === 'claim') toast({ tone: 'success', message: 'Claimed. It is yours now.', action: { label: 'Undo', onClick: () => act.mutate({ task, action: 'release' }) } });
      else if (action === 'done') toast({ tone: 'success', message: 'Marked done.' });
      else if (action === 'assign') toast({ tone: 'success', message: `Given to ${team.data?.members.find((m) => m.userId === body?.userId)?.name ?? 'your teammate'}.` });
      else if (action === 'notes') toast({ tone: 'success', message: 'Note added.' });
      else if (action === 'plan') toast({ tone: 'success', message: body?.urgent === true ? 'Marked urgent. It leads the queue.' : body?.urgent === false ? 'No longer urgent.' : body?.dueOn ? 'Due day set.' : 'Due day cleared.' });
      else toast({ tone: 'success', message: 'Released. It is back in the queue.' });
    },
    onSettled: () => { void queries.invalidateQueries({ queryKey: ['tasks', clinicId] }); void queries.invalidateQueries({ queryKey: ['patient', clinicId] }); },
  });
  const tz = clinic?.timezone ?? 'UTC';

  if (isPending) return <><PageHeader title="Requests" /><Skeleton className="h-64" /></>;
  if (!can('tasks:read')) {
    return <><PageHeader title="Requests" /><Card><Empty title="Requests are for the front desk">Your role can see calls and settings, not requests, because they name {terms.patients}.</Empty></Card></>;
  }
  const teammates = (team.data?.members ?? []).filter((m) => m.role !== 'viewer');
  // the clinic's own field, filtered here: the values are already on the cards
  const shown = (tasks.data?.tasks ?? []).filter((t) => !filterField || !fieldFilter.value
    || (filterField.kind === 'multi' ? multiValues(t.custom[filterField.id]).includes(fieldFilter.value) : t.custom[filterField.id] === fieldFilter.value));

  return (
    <>
      <PageHeader title="Requests" description={<>What callers asked the team for, the newest first. The assistant never approves a refill; that stays with your team. Times are {zoneLabel(tz)}.</>}
        actions={can('settings:write') ? <Link href={`/c/${clinicId}/settings/fields?tab=requests`} className={buttonStyles({ variant: 'ghost' })}><SlidersHorizontal /> Manage fields</Link> : undefined} />
      <details className="group mb-5 rounded-lg border border-border bg-surface text-sm shadow-xs">
        <summary className="focus-ring flex cursor-pointer list-none items-center gap-2 rounded-lg px-4 py-2.5 font-medium text-text-muted hover:text-text [&::-webkit-details-marker]:hidden">
          <Info className="size-4" aria-hidden /> What each kind of request means
          <ChevronDown className="ml-auto size-4 transition-transform group-open:rotate-180" aria-hidden />
        </summary>
        <dl className="grid gap-x-6 gap-y-3 border-t border-border px-4 py-3 md:grid-cols-2">
          {(['refill', 'callback', 'review', 'follow_up'] as const).map((t) => (
            <div key={t}><dt className="font-medium">{taskType(t, terms.patient)}</dt><dd className="text-text-muted">{taskExplained(t, terms.patient === 'pet')}</dd></div>
          ))}
        </dl>
      </details>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border border-border-strong p-0.5" role="tablist" aria-label="Status">
          {(['open', 'done'] as const).map((s) => (
            <button key={s} id={`requests-tab-${s}`} aria-controls="requests-panel" role="tab" aria-selected={status === s} onClick={() => setStatus(s)}
              className={cn('rounded px-3 py-1 text-sm focus-ring', status === s ? 'bg-primary text-on-primary' : 'text-text-muted hover:text-text')}>
              {s === 'open' ? 'Open' : 'Done'}
            </button>
          ))}
        </div>
        <Label htmlFor="request-type" className="sr-only">Type</Label>
        <Select id="request-type" className="h-8 w-48" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All types</option>
          {Object.keys(TASK_TYPES).map((k) => <option key={k} value={k}>{taskType(k, terms.patient)}</option>)}
        </Select>
        <Label htmlFor="request-who" className="sr-only">Assigned to</Label>
        <Select id="request-who" className="h-8 w-44" value={who} onChange={(e) => setWho(e.target.value as Who)}>
          <option value="everyone">Anyone</option>
          <option value="me">Assigned to me</option>
          <option value="unassigned">Unassigned</option>
        </Select>
        <div className="relative min-w-56 flex-1">
          <Label htmlFor="request-search" className="sr-only">Search requests</Label>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-muted" aria-hidden />
          <Input id="request-search" type="search" className="h-8 pl-8" autoComplete="off" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)}
            placeholder="Name, medication, phone digits…" />
        </div>
        <div className="flex items-center gap-1.5 text-sm" role="group" aria-label="Came in between">
          <Label htmlFor="request-from" className="text-text-muted">From</Label>
          <Input id="request-from" type="date" className="h-8 w-38" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
          <Label htmlFor="request-to" className="text-text-muted">to</Label>
          <Input id="request-to" type="date" className="h-8 w-38" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </div>
        {filterable.length > 0 && (
          <div className="flex items-center gap-1.5" role="group" aria-label="Filter by a field">
            <Label htmlFor="request-field" className="sr-only">Field</Label>
            <Select id="request-field" className="h-8 w-40" value={fieldFilter.id} onChange={(e) => setFieldFilter({ id: e.target.value, value: '' })}>
              <option value="">Any field</option>
              {filterable.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </Select>
            {filterField && (
              <>
                <Label htmlFor="request-field-value" className="sr-only">Value</Label>
                <Select id="request-field-value" className="h-8 w-40" value={fieldFilter.value} onChange={(e) => setFieldFilter({ ...fieldFilter, value: e.target.value })}>
                  <option value="">Any value</option>
                  {(filterField.kind === 'yesno' ? ['yes', 'no'] : filterField.options ?? []).map((o) => <option key={o} value={o}>{filterField.kind === 'yesno' ? (o === 'yes' ? 'Yes' : 'No') : o}</option>)}
                </Select>
              </>
            )}
          </div>
        )}
        {filtered && <Button size="sm" variant="ghost" onClick={() => { setType(''); setWho('everyone'); setText(''); setFrom(''); setTo(''); setFieldFilter({ id: '', value: '' }); }}><X /> Clear</Button>}
      </div>
      <div role="tabpanel" id="requests-panel" aria-labelledby={`requests-tab-${status}`}>
      {tasks.isError && <Alert tone="danger" className="mb-4">Requests did not load. They try again every 30 seconds; refresh if it keeps failing.</Alert>}
      {team.data && !team.data.members.some((m) => m.approvesRefills) && tasks.data?.tasks.some((t) => t.type === 'refill' && t.status === 'open') && (
        <Alert tone="warn" className="mb-5">
          Nobody can approve refills yet. On the <Link href={`/c/${clinicId}/team`} className="underline">Team page</Link>, tick Approves refills for your {terms.patient === 'pet' ? 'veterinarians' : 'prescribers'}.
        </Alert>
      )}
      {tasks.isPending ? <div className="grid gap-4 md:grid-cols-2"><Skeleton className="h-56" /><Skeleton className="h-56" /></div> : !shown.length ? (
        <Card><Empty title={status === 'open' ? 'Nothing waiting' : 'Nothing closed yet'}>
          {filtered ? 'Nothing matches these filters.' : status === 'open' ? `New refill and callback requests, and new ${terms.patients} to check, appear here as calls come in.` : 'Requests you mark done appear here, with what came of them.'}
        </Empty></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {shown.map((t) => (
            <RequestCard key={t.id} fields={requestFields} task={t} patientWord={terms.patient} clinicId={clinicId} tz={tz} today={localDateOf(new Date(), tz)} meId={me?.user.id} busy={act.isPending} teammates={teammates}
              canWork={can('tasks:work')} canReassign={can('tasks:reassign')} canOpenPatient={can('patients:read')} canApprove={!!clinic?.approvesRefills}
              onAct={(action, body) => act.mutate({ task: t, action, body })} />
          ))}
        </div>
      )}
      </div>
    </>
  );
}

function RequestCard({ task: t, fields, patientWord, clinicId, tz, today, meId, busy, teammates, canWork, canReassign, canOpenPatient, canApprove, onAct }: {
  task: Task; fields: CustomField[]; patientWord: string; clinicId: string; tz: string; today: string; meId?: string; busy: boolean; teammates: MemberList['members'];
  canWork: boolean; canReassign: boolean; canOpenPatient: boolean; canApprove: boolean;
  onAct: (action: 'claim' | 'done' | 'release' | 'notes' | 'assign' | 'plan', body?: ActBody) => void;
}) {
  const [note, setNote] = useState('');
  const [closing, setClosing] = useState(false);
  const [editingFields, setEditingFields] = useState(false);
  const [outcome, setOutcome] = useState(t.type === 'refill' && canApprove ? 'refill_sent' : t.type === 'review' ? 'details_confirmed' : 'called_back');
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
            <p className="text-xs text-text-muted">{taskType(t.type, patientWord)}, {open ? <>came in <RelativeTime iso={t.createdAt} exact={clinicTime(t.createdAt, tz, 'long')} /></> : `closed ${clinicTime(t.doneAt ?? t.createdAt, tz)}${t.doneByName ? ` by ${t.doneByName}` : ''}`}</p>
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-1.5">
          {open && t.urgent && <Badge tone="danger"><AlertTriangle /> Urgent</Badge>}
          {open && t.dueOn && <Badge tone={t.dueOn <= today ? 'warn' : 'neutral'}>{t.dueOn < today ? 'Overdue, due ' : 'Due '}{t.dueOn === today ? 'today' : dayTitle(t.dueOn, 'short')}</Badge>}
          {!open ? <Badge tone="ok">Done</Badge>
            : t.assigneeUserId ? <Badge tone="accent"><Hand /> {mine ? 'You have it' : `${t.assigneeName ?? 'Someone'} has it`}</Badge> : <Badge tone="warn">Unclaimed</Badge>}
        </div>
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
        {!open && t.outcome === 'refill_ready' && <><dt className="text-text-muted">Text</dt><dd><TextStatus clinicId={clinicId} filter={{ taskId: t.id }} timeZone={tz} empty="No text recorded yet. It goes out within a minute of closing." /></dd></>}
        {fields.filter((f) => t.custom[f.id]).map((f) => (
          <div key={f.id} className="contents"><dt className="text-text-muted">{f.label}</dt><dd>{shownValue(f, t.custom[f.id])}</dd></div>
        ))}
        {t.callId && <><dt className="text-text-muted">From</dt><dd><Link href={`/c/${clinicId}/calls/${t.callId}`} className="text-primary hover:underline">The call, {clinicTime(t.createdAt, tz)}</Link></dd></>}
      </dl>
      {fields.length > 0 && canWork && (
        <div className="border-t border-border px-5 py-3">
          {editingFields
            ? <CustomFieldsForm compact clinicId={clinicId} fields={fields} values={t.custom} canWrite saveUrl={`/clinics/${clinicId}/tasks/${t.id}/fields`} queryKey={['tasks', clinicId]} />
            : <Button size="sm" variant="ghost" onClick={() => setEditingFields(true)}>{fields.some((f) => t.custom[f.id]) ? 'Edit details' : 'Add details'}</Button>}
        </div>
      )}
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
                {Object.entries(TASK_OUTCOMES).filter(([k]) => (!k.startsWith('refill_') || t.type === 'refill') && (k !== 'details_confirmed' || t.type === 'review'))
                  .map(([k, v]) => <option key={k} value={k} disabled={DECISIONS.has(k) && !canApprove}>{v}</option>)}
              </Select>
              {t.type === 'refill' && !canApprove && (
                <p className="w-full text-xs text-text-muted">A {patientWord === 'pet' ? 'veterinarian' : 'prescriber'} marked as approving refills decides this one (sent, ready or not approved); you can add a note or call the {patientWord === 'pet' ? 'owner' : 'patient'}.</p>
              )}
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
              <Button size="sm" variant="ghost" disabled={busy} aria-pressed={t.urgent} onClick={() => onAct('plan', { urgent: !t.urgent })}>{t.urgent ? 'Not urgent' : 'Urgent'}</Button>
              <Label htmlFor={`due-${t.id}`} className="sr-only">Due</Label>
              <Input id={`due-${t.id}`} type="date" className="h-8 w-38" title="Due" value={t.dueOn ?? ''} disabled={busy} onChange={(e) => onAct('plan', { dueOn: e.target.value || null })} />
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
