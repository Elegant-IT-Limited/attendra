// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { MemberList, Task, TaskList } from '@attendra/api/contracts';
import { type CustomField, localDateOf, multiValues } from '@attendra/core';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, ChevronRight, Flag, Hand, Info, Phone, PhoneCall, Pill, Plus, Search, SlidersHorizontal, UserCheck, Voicemail, X } from 'lucide-react';
import Link from 'next/link';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { PageHeader } from '@/components/shell';
import { TextStatus } from '@/components/calls/text-status';
import { CustomFieldInputs, CustomFieldsForm, shownValue } from '@/components/patients/custom-fields';
import { Badge } from '@/components/ui/badge';
import { Button, buttonStyles } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, Empty, Skeleton } from '@/components/ui/feedback';
import { useSettled } from '@/components/patients/patient-search';
import { Field, Input, Label, Select, Textarea } from '@/components/ui/input';
import { Panel } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { api, ApiFailure, useClinic, useClinicConfig } from '@/lib/api';
import { ago, clinicTime, dayTitle, dob, phone, TASK_KIND_ORDER, TASK_OUTCOMES, TASK_TYPES, taskExplained, taskType, zoneLabel } from '@/lib/format';
import { useTerms } from '@/lib/terms';
import { RelativeTime } from '@/components/ui/bits';
import { Segmented } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

const DETAIL_LABELS: Record<string, string> = {
  topic: 'Topic',
  medication: 'Medication', pharmacy: 'Pharmacy', callback_number: 'Call back on', reason: 'What it is about',
  first_name: 'First name', last_name: 'Last name', date_of_birth: 'Date of birth', gender: 'Gender', phone: 'Phone', guardian_name: 'Parent or guardian', possible_duplicate: 'Worth a look',
  suggested: 'Suggested next step',
  pet_name: 'Pet', species: 'Kind of animal', sex: 'Sex', owner_name: 'Owner', date_of_birth_note: 'Birthday note',
};
/** A detail as people read it: numbers you can tap, dates in words, the kind and sex capitalised. */
function shownDetail(k: string, v: string) {
  if ((k === 'callback_number' || k === 'phone') && /^\+?\d[\d\s().-]{6,}$/.test(v)) return <a className="hover:underline" href={`tel:${v}`}>{phone(v)}</a>;
  if (k === 'date_of_birth' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return dob(v);
  if (k === 'species' || k === 'sex' || k === 'gender') return v.charAt(0).toUpperCase() + v.slice(1);
  return v;
}

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
  // the request open in the side panel: closed when it is marked done and when the list switches
  // between Open and Done, so a request never reopens by itself over the list it moved to
  const [openId, setOpenId] = useState<string | null>(null);
  const setStatus = (s: 'open' | 'done') => {
    setOpenId(null);
    const q = new URLSearchParams(search.toString());
    if (s === 'done') q.set('status', 'done'); else q.delete('status');
    router.replace(q.size ? `${pathname}?${q}` : pathname, { scroll: false });
  };
  // a link can open the list on one type: the refill queue is ?type=refill
  const [type, setType] = useState(() => { const t = search.get('type') ?? ''; return Object.hasOwn(TASK_TYPES, t) ? t : ''; });
  // one of the clinic's own kinds of request (Settings, Fields and lists): the request's topic
  const [topic, setTopic] = useState('');
  const [adding, setAdding] = useState(false);
  const [who, setWho] = useState<Who>('everyone');
  // what is typed narrows the list as it is typed; the dates are the clinic's own days
  const [text, setText] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // one of the clinic's own request fields, a dropdown or yes-or-no, and its value
  const [fieldFilter, setFieldFilter] = useState<{ id: string; value: string }>({ id: '', value: '' });
  const config = useClinicConfig(clinicId);
  const requestFields = config.data?.requestFields ?? [];
  const topics = config.data?.requestTopics ?? [];
  const filterable = requestFields.filter((f) => f.kind === 'choice' || f.kind === 'multi' || f.kind === 'yesno');
  const filterField = filterable.find((f) => f.id === fieldFilter.id);
  const q = useSettled(text.trim());
  const queries = useQueryClient();
  // a POST body: what is typed can be a name or a phone number, and never goes in an address
  const filters = { status, ...(type ? { type } : {}), ...(who !== 'everyone' ? { assignee: who } : {}), q, ...(from ? { from } : {}), ...(to ? { to } : {}) };
  const filtered = !!(type || topic || who !== 'everyone' || q || from || to || fieldFilter.value);
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
      else if (action === 'done') { setOpenId((id) => (id === task.id ? null : id)); toast({ tone: 'success', message: 'Marked done.' }); }
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
  const shown = (tasks.data?.tasks ?? []).filter((t) => (!filterField || !fieldFilter.value
    || (filterField.kind === 'multi' ? multiValues(t.custom[filterField.id]).includes(fieldFilter.value) : t.custom[filterField.id] === fieldFilter.value))
    && (!topic || t.details.topic === topic));

  return (
    <>
      <PageHeader title="Requests" description={<>What callers asked the team for, the newest first. The assistant never approves a refill; that stays with your team. Times are {zoneLabel(tz)}.</>}
        actions={(
          <>
            {can('settings:write') && <Link href={`/c/${clinicId}/settings/fields?tab=requests`} className={buttonStyles({ variant: 'ghost' })}><SlidersHorizontal /> Manage fields</Link>}
            {can('tasks:work') && <Button onClick={() => setAdding(true)}><Plus /> New request</Button>}
          </>
        )} />
      <NewRequest clinicId={clinicId} open={adding} onOpenChange={setAdding} topics={topics.map((t) => t.name)} fields={requestFields} patientWord={terms.patient} />
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
      {/* the same filter bar as Pets and Veterinarians: a card, the switch first, then search and the dropdowns */}
      <Card className="mb-4"><CardContent className="py-4">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter the list">
        <Segmented label="Status" value={status} onValueChange={setStatus} options={[{ value: 'open', label: 'Open' }, { value: 'done', label: 'Done' }]} />
        <Label htmlFor="request-type" className="sr-only">Type</Label>
        <Select id="request-type" className="h-8 w-48" value={topic ? `topic:${topic}` : type} onChange={(e) => {
          const v = e.target.value;
          if (v.startsWith('topic:')) { setType(''); setTopic(v.slice(6)); } else { setTopic(''); setType(v); }
        }}>
          <option value="">Any kind of request</option>
          <optgroup label="Built in">
            {TASK_KIND_ORDER.map((k) => <option key={k} value={k}>{taskType(k, terms.patient)}</option>)}
          </optgroup>
          {topics.length > 0 && (
            <optgroup label="Your kinds of request">
              {topics.map((t) => <option key={t.id} value={`topic:${t.name}`}>{t.name}</option>)}
            </optgroup>
          )}
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
        {filtered && <Button size="sm" variant="ghost" onClick={() => { setType(''); setTopic(''); setWho('everyone'); setText(''); setFrom(''); setTo(''); setFieldFilter({ id: '', value: '' }); }}><X /> Clear</Button>}
      </div>
      </CardContent></Card>
      <div aria-label={status === 'open' ? 'Open requests' : 'Done requests'} role="region">
      {tasks.isError && <Alert tone="danger" className="mb-4">Requests did not load. They try again every 30 seconds; refresh if it keeps failing.</Alert>}
      {team.data && !team.data.members.some((m) => m.approvesRefills) && tasks.data?.tasks.some((t) => t.type === 'refill' && t.status === 'open') && (
        <Alert tone="warn" className="mb-5">
          Nobody can approve refills yet. On the <Link href={`/c/${clinicId}/team`} className="underline">Team page</Link>, tick Approves refills for your {terms.patient === 'pet' ? 'veterinarians' : 'prescribers'}.
        </Alert>
      )}
      {tasks.isPending ? <Card className="space-y-2 p-4"><Skeleton className="h-12" /><Skeleton className="h-12" /><Skeleton className="h-12" /></Card> : !shown.length ? (
        <Card><Empty title={status === 'open' ? 'Nothing waiting' : 'Nothing closed yet'}>
          {filtered ? 'Nothing matches these filters.' : status === 'open' ? `New refill and callback requests, and new ${terms.patients} to check, appear here as calls come in.` : 'Requests you mark done appear here, with what came of them.'}
        </Empty></Card>
      ) : (
        <RequestList tasks={shown} status={status} patientWord={terms.patient} tz={tz} today={localDateOf(new Date(), tz)} meId={me?.user.id} openId={openId} onOpen={setOpenId} />
      )}
      </div>
      {/* one request at a time, on the right: its details, notes and actions, and what else came from the same call */}
      {(() => {
        const t = shown.find((x) => x.id === openId);
        const siblings = t?.callId ? shown.filter((x) => x.callId === t.callId && x.id !== t.id) : [];
        return (
          <Panel open={!!t} onOpenChange={(o) => { if (!o) setOpenId(null); }} side="right" className="max-w-xl"
            title={t ? `${nameOf(t)}: ${taskType(t.type, terms.patient)}` : 'Request'}>
            {t && (
              <div className="space-y-4">
                <RequestCard bare fields={requestFields} task={t} patientWord={terms.patient} clinicId={clinicId} tz={tz} today={localDateOf(new Date(), tz)} meId={me?.user.id} busy={act.isPending} teammates={teammates}
                  canWork={can('tasks:work')} canReassign={can('tasks:reassign')} canOpenPatient={can('patients:read')} canApprove={!!clinic?.approvesRefills}
                  onAct={(action, body) => act.mutate({ task: t, action, body })} />
                {siblings.length > 0 && (
                  <section aria-labelledby="same-call" className="space-y-2">
                    <h3 id="same-call" className="text-xs font-semibold uppercase tracking-wide text-text-muted">From the same call</h3>
                    <ul className="space-y-2">
                      {siblings.map((x) => {
                        const Icon = ICONS[x.type] ?? Phone;
                        return (
                          <li key={x.id}>
                            <button type="button" className="focus-ring flex w-full items-center gap-3 rounded-md border border-dashed border-border-strong px-3 py-2 text-left text-sm hover:bg-surface-sunken" onClick={() => setOpenId(x.id)}>
                              <Icon className="size-4 shrink-0 text-primary" aria-hidden />
                              <span className="min-w-0 flex-1"><span className="font-medium">{taskType(x.type, terms.patient)}</span> <span className="text-text-muted">{needOf(x).main}</span></span>
                              <ChevronRight className="size-4 text-text-muted" aria-hidden />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                )}
              </div>
            )}
          </Panel>
        );
      })()}
    </>
  );
}

/** Who a request is about, as the list and the panel name it. */
const nameOf = (t: Task) => t.patientName ?? t.details.pet_name ?? ([t.details.first_name, t.details.last_name].filter(Boolean).join(' ') || 'Caller not verified');

/** What a request needs, in one line, and the detail that goes with it: the most important things, without opening it. */
function needOf(t: Task): { main: string; sub: string } {
  const d = t.details;
  const callBack = d.callback_number ? `Call back on ${phone(d.callback_number)}` : null;
  const main = d.medication ?? d.topic ?? d.reason ?? (t.type === 'follow_up' ? d.suggested ?? t.followUp : null) ?? (t.type === 'review' ? 'Check the details the assistant took' : null) ?? taskType(t.type);
  const next = t.type === 'follow_up' ? d.suggested ?? t.followUp : null;
  const sub = [d.pharmacy, d.owner_name && d.owner_name !== nameOf(t) ? `Owner ${d.owner_name}` : null, next ? `Suggested: ${next}` : null, callBack, d.possible_duplicate ? 'Worth a look: maybe already on file' : null]
    .filter((x): x is string => !!x && x !== main).join(' · ');
  return { main, sub };
}

/**
 * The queue as one list: urgent requests first, then the ones nobody has, then the claimed
 * ones, each a row with who, what they need, how long it has waited and who has it. A row
 * opens the request on the right, so the list never moves under the reader.
 */
function RequestList({ tasks, status, patientWord, tz, today, meId, openId, onOpen }: {
  tasks: Task[]; status: 'open' | 'done'; patientWord: string; tz: string; today: string; meId?: string; openId: string | null; onOpen: (id: string) => void;
}) {
  const groups: { title: string; tasks: Task[] }[] = status === 'done'
    ? [{ title: 'Done', tasks }]
    : [
      { title: 'Urgent', tasks: tasks.filter((t) => t.urgent) },
      { title: 'Waiting', tasks: tasks.filter((t) => !t.urgent && !t.assigneeUserId) },
      { title: 'Claimed', tasks: tasks.filter((t) => !t.urgent && t.assigneeUserId) },
    ].filter((g) => g.tasks.length);
  return (
    <Card className="overflow-hidden">
      {groups.map((g) => (
        <div key={g.title} role="group" aria-label={`${g.title}, ${g.tasks.length}`} className="border-t border-border first:border-t-0">
          {status === 'open' && <h3 className="border-b border-border bg-surface-sunken px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-text-muted">{g.title} · {g.tasks.length}</h3>}
          <ul className="divide-y divide-border">
            {g.tasks.map((t) => <li key={t.id}><RequestRow task={t} patientWord={patientWord} tz={tz} today={today} meId={meId} selected={t.id === openId} onOpen={() => onOpen(t.id)} /></li>)}
          </ul>
        </div>
      ))}
    </Card>
  );
}

function RequestRow({ task: t, patientWord, tz, today, meId, selected, onOpen }: { task: Task; patientWord: string; tz: string; today: string; meId?: string; selected: boolean; onOpen: () => void }) {
  const Icon = ICONS[t.type] ?? Phone;
  const open = t.status === 'open';
  const need = needOf(t);
  const at = open ? t.createdAt : t.doneAt ?? t.createdAt;
  return (
    <button type="button" data-testid="task-row" onClick={onOpen} aria-current={selected || undefined}
      className={cn('focus-ring relative grid w-full grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3 text-left text-sm hover:bg-surface-sunken/60',
        'md:grid-cols-[2.25rem_minmax(0,1.1fr)_minmax(0,1.6fr)_8.5rem_auto_1rem]', selected && 'bg-primary-soft hover:bg-primary-soft')}>
      {open && t.urgent && <span className="absolute inset-y-0 left-0 w-1 rounded-r bg-danger" aria-hidden />}
      <span className="flex size-9 items-center justify-center rounded-full bg-primary-soft text-primary md:order-1"><Icon className="size-4" aria-hidden /></span>
      <span className="min-w-0 md:order-2">
        <span className="block truncate font-medium">{nameOf(t)}</span>
        <span className="block truncate text-xs text-text-muted">{taskType(t.type, patientWord)}</span>
      </span>
      <span className="flex flex-wrap justify-end gap-1.5 md:order-5">
        {open && t.urgent && <Badge tone="danger"><AlertTriangle /> Urgent</Badge>}
        {open && t.dueOn && <Badge tone={t.dueOn <= today ? 'warn' : 'neutral'}>{t.dueOn < today ? 'Overdue' : 'Due'} {t.dueOn === today ? 'today' : dayTitle(t.dueOn, 'short')}</Badge>}
        {!open ? <Badge tone="ok">{t.outcome ? TASK_OUTCOMES[t.outcome] : 'Done'}</Badge>
          : t.assigneeUserId ? <Badge tone="accent"><Hand /> {t.assigneeUserId === meId ? 'You have it' : `${t.assigneeName ?? 'Someone'} has it`}</Badge> : <Badge tone="warn">Unclaimed</Badge>}
      </span>
      <span className="col-span-2 col-start-2 min-w-0 md:order-3 md:col-span-1 md:col-start-auto">
        <span className="block truncate">{need.main}</span>
        {need.sub && <span className="block truncate text-xs text-text-muted">{need.sub}</span>}
      </span>
      <span className="hidden min-w-0 text-xs md:order-4 md:block">
        <time dateTime={at} title={clinicTime(at, tz, 'long')} className="block font-medium text-text">{open ? ago(Date.now() - Date.parse(at)) : clinicTime(at, tz)}</time>
        <span className="block truncate text-text-muted">{t.callId ? 'From a call' : 'Added by the team'}</span>
      </span>
      <ChevronRight className="hidden size-4 text-text-muted md:order-6 md:block" aria-hidden />
    </button>
  );
}

function RequestCard({ task: t, fields, patientWord, clinicId, tz, today, meId, busy, teammates, canWork, canReassign, canOpenPatient, canApprove, onAct, bare }: {
  /** Inside the side panel: no card edge of its own. */
  bare?: boolean;
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
    <Card className={cn('flex flex-col', bare && 'border-0 shadow-none')} data-testid="task">
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
            <dd>{shownDetail(k, v)}</dd>
          </div>
        ))}
        {/* the call's one next step belongs on its follow-up; on a callback or a pet to check it repeated what the card says */}
        {open && t.type === 'follow_up' && t.followUp && t.followUp !== t.details.suggested && <><dt className="text-text-muted">Suggested by the assistant</dt><dd>{t.followUp}</dd></>}
        {!open && t.outcome && <><dt className="text-text-muted">Outcome</dt><dd className="font-medium">{TASK_OUTCOMES[t.outcome]}</dd></>}
        {!open && t.outcome === 'refill_ready' && <><dt className="text-text-muted">Text</dt><dd><TextStatus clinicId={clinicId} filter={{ taskId: t.id }} timeZone={tz} empty="No text recorded yet. It goes out within a minute of closing." /></dd></>}
        {fields.map((f) => (
          <div key={f.id} className="contents"><dt className="text-text-muted">{f.label}</dt><dd>{t.custom[f.id] ? shownValue(f, t.custom[f.id]) : <span className="text-text-muted">Not filled in</span>}</dd></div>
        ))}
        {t.callId && <><dt className="text-text-muted">From</dt><dd><Link href={`/c/${clinicId}/calls/${t.callId}`} className="text-primary hover:underline">The call, {clinicTime(t.createdAt, tz)}</Link></dd></>}
        {!t.callId && <><dt className="text-text-muted">From</dt><dd>Added by the team, {clinicTime(t.createdAt, tz)}</dd></>}
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

/** A request written down by hand: a voicemail someone listened to, a walk-in's question, a call taken at the desk. */
function NewRequest({ clinicId, open, onOpenChange, topics, fields, patientWord }: { clinicId: string; open: boolean; onOpenChange: (o: boolean) => void; topics: string[]; fields: CustomField[]; patientWord: string }) {
  const queries = useQueryClient();
  const toast = useToast();
  const blank = { kind: 'callback', reason: '', callbackNumber: '', urgent: false, dueOn: '', medication: '', pharmacy: '' };
  const [draft, setDraft] = useState(blank);
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const refill = draft.kind === 'refill';
  const save = useMutation({
    mutationFn: async () => {
      const topic = draft.kind.startsWith('topic:') ? draft.kind.slice(6) : null;
      const type = topic ? 'callback' : draft.kind;
      const r = await api<{ id: string }>(`/clinics/${clinicId}/tasks`, { method: 'POST', body: JSON.stringify({
        type, topic, reason: draft.reason, callbackNumber: draft.callbackNumber.trim() || null, urgent: draft.urgent, dueOn: draft.dueOn || null,
        ...(refill ? { medication: draft.medication.trim() || null, pharmacy: draft.pharmacy.trim() || null } : {}),
      }) });
      // the clinic's own fields go with it; a problem with them leaves the request in the queue and says so
      if (fields.length && Object.values(custom).some((v) => v.trim())) {
        const values = Object.fromEntries(fields.map((f) => [f.id, custom[f.id] ?? '']));
        const failed = await api<void>(`/clinics/${clinicId}/tasks/${r.id}/fields`, { method: 'PUT', body: JSON.stringify({ values }) }).then(() => false, () => true);
        if (failed) return { ...r, fieldsFailed: true };
      }
      return { ...r, fieldsFailed: false };
    },
    onSuccess: (r) => {
      toast(r.fieldsFailed
        ? { tone: 'error', message: 'The request is added, but not its details. Open it and use Edit details.' }
        : { tone: 'success', message: 'Request added. It is in the queue for the team.' });
      setDraft(blank); setCustom({}); setError(null); onOpenChange(false);
      void queries.invalidateQueries({ queryKey: ['tasks', clinicId] });
    },
    onError: (e) => setError(e instanceof ApiFailure && e.body.issues?.length ? e.body.issues[0]!.message : 'That did not save. Try again.'),
  });
  return (
    <Panel open={open} onOpenChange={onOpenChange} side="right" className="max-w-xl" title="New request" description="Write down something for the team: a voicemail, a walk-in's question, a call you took. It joins the same queue as the assistant's."
      footer={(
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button loading={save.isPending} disabled={draft.reason.trim().length < 3} onClick={() => save.mutate()}>Add request</Button>
        </>
      )}>
      <div className="space-y-6">
        <fieldset className="space-y-2">
          <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">1 · What kind</legend>
          <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="Kind of request">
            {/* the same kinds as the filter; a new pet or patient to check is the assistant's own, with the record it is about */}
            {TASK_KIND_ORDER.map((k) => {
              const Icon = ICONS[k] ?? Phone;
              const off = k === 'review';
              return (
                <button key={k} type="button" disabled={off} aria-pressed={draft.kind === k} onClick={() => setDraft({ ...draft, kind: k })}
                  className={cn('focus-ring flex items-start gap-3 rounded-lg border border-border-strong bg-surface p-3 text-left text-sm hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-55',
                    draft.kind === k && 'border-primary bg-primary-soft ring-1 ring-primary hover:bg-primary-soft')}>
                  <Icon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                  <span><span className="block font-medium">{taskType(k, patientWord)}</span>
                    <span className="block text-xs text-text-muted">{off ? 'Added by the assistant, with the record it is about' : taskExplained(k, patientWord === 'pet')}</span></span>
                </button>
              );
            })}
            {topics.map((t) => (
              <button key={t} type="button" aria-pressed={draft.kind === `topic:${t}`} onClick={() => setDraft({ ...draft, kind: `topic:${t}` })}
                className={cn('focus-ring flex items-start gap-3 rounded-lg border border-border-strong bg-surface p-3 text-left text-sm hover:bg-surface-sunken',
                  draft.kind === `topic:${t}` && 'border-primary bg-primary-soft ring-1 ring-primary hover:bg-primary-soft')}>
                <Flag className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                <span><span className="block font-medium">{t}</span><span className="block text-xs text-text-muted">One of your own kinds</span></span>
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset className="space-y-3">
          <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">2 · Who to reach</legend>
          <Field label="Call back on" hint="The number to reach them on, if there is one.">
            {(p) => <Input {...p} type="tel" autoComplete="off" value={draft.callbackNumber} onChange={(e) => setDraft({ ...draft, callbackNumber: e.target.value })} placeholder="(303) 555-0100" />}
          </Field>
        </fieldset>
        <fieldset className="space-y-3">
          <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">3 · Details</legend>
          {refill && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Medicine" hint="Optional.">{(p) => <Input {...p} maxLength={120} value={draft.medication} onChange={(e) => setDraft({ ...draft, medication: e.target.value })} />}</Field>
              <Field label="Pharmacy" hint="Or pick up at the clinic. Optional.">{(p) => <Input {...p} maxLength={120} value={draft.pharmacy} onChange={(e) => setDraft({ ...draft, pharmacy: e.target.value })} />}</Field>
            </div>
          )}
          {refill && <Alert tone="info">Only a {patientWord === 'pet' ? 'veterinarian' : 'prescriber'} marked as approving refills on the Team page decides it: sent, ready or not approved.</Alert>}
          <Field label="What it is about" hint="In a sentence, for whoever picks it up.">
            {(p) => <Textarea {...p} rows={3} maxLength={300} value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })} placeholder="e.g. Wants a dental cleaning for Bella next month" />}
          </Field>
        </fieldset>
        <fieldset className="space-y-3">
          <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">4 · When</legend>
          <div className="grid items-end gap-4 sm:grid-cols-2">
            <label className="flex items-start gap-3 rounded-lg border border-border p-3 text-sm">
              <input type="checkbox" className="mt-0.5" checked={draft.urgent} onChange={(e) => setDraft({ ...draft, urgent: e.target.checked })} />
              <span><span className="block font-medium">Urgent</span><span className="block text-xs text-text-muted">It goes to the top for everyone</span></span>
            </label>
            <Field label="Due" hint="Optional.">{(p) => <Input {...p} type="date" value={draft.dueOn} onChange={(e) => setDraft({ ...draft, dueOn: e.target.value })} />}</Field>
          </div>
        </fieldset>
        {fields.length > 0 && (
          <fieldset className="space-y-2">
            <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">5 · Your own fields</legend>
            <CustomFieldInputs idPrefix="new-req-cf" compact fields={fields} values={custom} onChange={(id, v) => setCustom((c) => ({ ...c, [id]: v }))} />
          </fieldset>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Panel>
  );
}
