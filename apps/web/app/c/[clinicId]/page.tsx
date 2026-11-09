// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useProblem } from '@/components/ui/toast';
import type { CallList, Overview, Schedule, WaitingTasks, WebhookEndpoints } from '@attendra/api/contracts';
import { bookableWindows, type ClinicConfig, holdsTime, localDateOf, localParts, shownProviders, toMinutes, providerName } from '@attendra/core';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Flag, PhoneCall, PhoneOff, Pill, Siren, UserCheck, Voicemail, Webhook } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { LiveNow } from '@/components/calls/live-now';
import { Outcome } from '@/components/calls/outcome';
import { GoLiveCard, PlanMeter } from '@/components/plan';
import { PageHeader } from '@/components/shell';
import { AnimatedNumber, RelativeTime, StatCard } from '@/components/ui/bits';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, Empty, Skeleton } from '@/components/ui/feedback';
import { api, ApiFailure, useClinic, useClinicConfig } from '@/lib/api';
import { requestNumber, clinicTime, dayTitle, taskType, timeOf, TOOLS, usd, visitTypeName, zoneLabel } from '@/lib/format';
import { useTerms } from '@/lib/terms';
import { cn } from '@/lib/utils';
import { SAFETY_POLL_MS, SAFETY_POLL_WORDS } from '@/lib/changes';
import { patchRequestElsewhere } from '@/lib/optimistic';

/** How often the ages ("12 min ago") and the "next" marker move. */
const CLOCK_MS = 30_000;
const LINK = 'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border-strong bg-surface px-3 text-sm font-medium hover:bg-surface-sunken focus-ring';

/** The home screen: what needs someone, today's appointments, and what the assistant did, kept current by the change stream. */
export default function Today() {
  const { clinicId } = useParams<{ clinicId: string }>();
  const { can, data: me, clinic: account } = useClinic(clinicId);
  const config = useClinicConfig(clinicId);
  const clinic = config.data;
  const tz = clinic?.timezone ?? 'UTC';
  // a clock for the ages and the "next" marker
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), CLOCK_MS); return () => clearInterval(t); }, []);
  const today = localDateOf(new Date(now), tz);
  // the change stream refreshes these as things happen; the slow poll is only a safety net
  const live = { refetchInterval: SAFETY_POLL_MS, placeholderData: keepPreviousData };

  const overview = useQuery({ queryKey: ['overview', clinicId], queryFn: () => api<Overview>(`/clinics/${clinicId}/overview?days=7`), ...live });
  const calls = useQuery({ queryKey: ['calls', clinicId, 'recent'], queryFn: () => api<CallList>(`/clinics/${clinicId}/calls?limit=50`), ...live });
  const waiting = useQuery({ queryKey: ['tasks', clinicId, 'waiting'], queryFn: () => api<WaitingTasks>(`/clinics/${clinicId}/tasks/waiting`), enabled: can('tasks:list'), ...live });
  // managers hear here when Attendra turned a webhook endpoint off
  const hooks = useQuery({ queryKey: ['webhooks', clinicId], queryFn: () => api<WebhookEndpoints>(`/clinics/${clinicId}/webhooks`), enabled: can('integrations:manage'), ...live });
  const schedule = useQuery({
    queryKey: ['schedule', clinicId, today, 1, ''],
    queryFn: () => api<Schedule>(`/clinics/${clinicId}/appointments?from=${today}&days=1`),
    enabled: !!clinic && can('schedule:list'), ...live,
  });

  if (!clinic) return <><PageHeader title="Today" /><Skeleton className="h-96" /></>;
  // browser tests are left out of the counts, so they are left out of the lists too; Live now still shows one going on
  const phoneCalls = { ...calls, data: calls.data && { ...calls.data, calls: calls.data.calls.filter((c) => c.channel === 'phone') } };
  const hour = localParts(new Date(now), tz).minutes / 60;
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <>
      <PageHeader title="Today" description={<>{greeting}. {dayTitle(today)}, times are {zoneLabel(tz)}.</>} />
      <LiveNow clinicId={clinicId} canWatch={can('calls:read')} />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="At a glance">
        <StatCard label="Calls today" value={overview.data?.today.callsAnswered ?? null} trend={overview.data?.daily.map((d) => d.calls)} hint="Trend over the last 7 days" />
        <StatCard label="Booked, last 7 days" value={overview.data ? overview.data.period.booked : null} trend={overview.data?.daily.map((d) => d.booked)} hint="By the assistant" />
        {clinic.industry === 'vet' ? (
          // a vet clinic's two queues: refills waiting for a vet, and the animals sent to the emergency hospital
          <>
            <StatCard label="Refills waiting" value={can('tasks:list') ? (waiting.data?.byType.refill ?? (waiting.data ? 0 : null)) : null} hint="Open the refill queue" href={`/c/${clinicId}/requests?type=refill`} />
            <StatCard label="Emergencies, last 7 days" value={overview.data ? overview.data.period.emergencies : null} tone="danger" hint="Open the emergency log" href={`/c/${clinicId}/calls?emergency=true`} />
          </>
        ) : (
          <>
            <StatCard label="Requests waiting" value={can('tasks:list') ? (waiting.data?.total ?? null) : null} hint="Nobody has them yet" />
            <StatCard label="After-hours calls" value={overview.data ? overview.data.period.afterHours : null} hint="Answered in the last 7 days" />
          </>
        )}
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <NeedsAttention clinicId={clinicId} tz={tz} now={now} calls={phoneCalls} waiting={waiting} canTasks={can('tasks:read')} canWork={can('tasks:work')} canOpenCalls={can('calls:read')}
            turnedOff={(hooks.data?.endpoints ?? []).filter((e) => e.disabledReason === 'repeated_failures')} />
          <TodaysSchedule clinicId={clinicId} clinic={clinic} now={now} today={today} schedule={schedule} allowed={can('schedule:list')} />
        </div>
        <div className="space-y-6">
          <GoLiveCard clinicId={clinicId} />
          <PlanMeter clinicId={clinicId} />
          <AssistantDid overview={overview} hosted={!!account?.accountLinks.length} />
          <RecentCalls clinicId={clinicId} tz={tz} calls={phoneCalls} canOpen={can('calls:read')} canTest={can('calls:test') && !!me?.testCalls} />
        </div>
      </div>
    </>
  );
}

type Q<T> = { data?: T; isPending: boolean; isError: boolean };

// the same icon per request type as the Requests page
const REQUEST_ICONS = { refill: Pill, callback: PhoneCall, voicemail: Voicemail, review: UserCheck, follow_up: Flag } as const;
function RequestIcon({ type }: { type: keyof typeof REQUEST_ICONS }) {
  const Icon = REQUEST_ICONS[type] ?? PhoneCall;
  return <Icon className="size-4 text-primary" />;
}

function NeedsAttention({ clinicId, tz, now, calls, waiting, canTasks, canWork, canOpenCalls, turnedOff }: {
  clinicId: string; tz: string; now: number; calls: Q<CallList>; waiting: Q<WaitingTasks>; canTasks: boolean; canWork: boolean; canOpenCalls: boolean;
  turnedOff: WebhookEndpoints['endpoints'];
}) {
  const terms = useTerms(clinicId);
  const router = useRouter();
  const queries = useQueryClient();
  const problem = useProblem();
  const setTaken = (message: string | null) => { if (message) problem({ title: 'Not claimed', message }); };
  const claim = useMutation({
    mutationFn: (id: string) => api<void>(`/clinics/${clinicId}/tasks/${id}/claim`, { method: 'POST' }),
    // it leaves "waiting for someone" at once, and comes back if someone else had it first
    onMutate: async (id) => ({ undo: await patchRequestElsewhere(queries, clinicId, id, 'claim') }),
    onSuccess: () => { void queries.invalidateQueries({ queryKey: ['tasks', clinicId] }); router.push(`/c/${clinicId}/requests`); },
    onError: (e, _id, ctx) => { ctx?.undo(); setTaken(e instanceof ApiFailure && e.status === 409 ? 'Someone else claimed that one first.' : 'That did not work. Try again.'); void queries.invalidateQueries({ queryKey: ['tasks', clinicId] }); },
  });
  const day = now - 86_400_000;
  const recent = (calls.data?.calls ?? []).filter((c) => Date.parse(c.startedAt) >= day);
  const emergencies = recent.filter((c) => c.emergency);
  // flagged by the summary and not yet looked at, from the last week; emergencies are already listed above them
  const flagged = (calls.data?.calls ?? []).filter((c) => c.needsReview && !c.emergency && Date.parse(c.startedAt) >= now - 7 * 86_400_000);
  // only calls that are over: one still going has no outcome yet, and is under Live now
  const unresolved = recent.filter((c) => c.endedAt && !c.emergency && !c.needsReview && (c.outcome === 'transferred' || c.outcome === 'abandoned' || c.outcome === 'no_audio' || c.outcome === null));
  const requests = canTasks ? waiting.data?.tasks ?? [] : [];
  // a flagged call that became a follow-up request is listed once, as the request
  const followedUp = new Set(requests.flatMap((t) => (t.type === 'follow_up' && t.callId ? [t.callId] : [])));
  const request = (t: (typeof requests)[number]) => ({
    key: t.id, icon: t.urgent ? <AlertTriangle className="size-4 text-danger" /> : <RequestIcon type={t.type} />, ...(t.urgent ? { tone: 'danger' as const } : {}),
    title: `${t.urgent ? (t.origin === 'emergency' ? 'Emergency · ' : 'Urgent · ') : ''}${requestNumber(t.number)} · ${taskType(t.type, terms.patient)}`, detail: <>Came in <RelativeTime iso={t.createdAt} exact={clinicTime(t.createdAt, tz, 'long')} now={now} />, nobody has it yet</>,
    action: canWork
      ? <Button size="sm" variant="outline" disabled={claim.isPending} onClick={() => claim.mutate(t.id)}>Claim</Button>
      : <Link href={`/c/${clinicId}/requests`} className={LINK}>Open</Link>,
  });
  const items: { key: string; icon: ReactNode; title: string; detail: ReactNode; action: ReactNode; tone?: 'danger' }[] = [
    // an urgent request (taken during an emergency) is at the very top, before everything else
    ...requests.filter((t) => t.urgent).map(request),
    ...emergencies.map((c) => ({
      key: c.id, icon: <Siren className="size-4 text-danger" />, tone: 'danger' as const, title: 'Emergency language on a call', detail: <>{timeOf(c.startedAt, tz)}, <RelativeTime iso={c.startedAt} exact={clinicTime(c.startedAt, tz, 'long')} now={now} /></>,
      action: canOpenCalls ? <Link href={`/c/${clinicId}/calls/${c.id}`} className={LINK}>Review the call</Link> : null,
    })),
    ...requests.filter((t) => !t.urgent).map(request),
    ...flagged.filter((c) => !followedUp.has(c.id)).map((c) => ({
      key: c.id, icon: <Flag className="size-4 text-warning" />, title: 'A call flagged for review',
      detail: <>{timeOf(c.startedAt, tz)}, <RelativeTime iso={c.startedAt} exact={clinicTime(c.startedAt, tz, 'long')} now={now} />. The summary says why.</>,
      action: canOpenCalls ? <Link href={`/c/${clinicId}/calls/${c.id}`} className={LINK}>Review the call</Link> : null,
    })),
    ...turnedOff.map((e) => ({
      key: e.id, icon: <Webhook className="size-4 text-danger" />, title: 'A webhook endpoint was turned off',
      detail: <>It failed {e.consecutiveFailures} events in a row. Nothing is being sent to it.</>,
      action: <Link href={`/c/${clinicId}/settings/integrations`} className={LINK}>Open Integrations</Link>,
    })),
    ...unresolved.map((c) => ({
      key: c.id, icon: <PhoneOff className="size-4 text-text-muted" />, title: c.outcome === 'transferred' ? 'A call went to a person' : c.outcome === 'no_audio' ? 'A caller heard nothing' : 'A call ended with nothing done',
      detail: <>{timeOf(c.startedAt, tz)}, <RelativeTime iso={c.startedAt} exact={clinicTime(c.startedAt, tz, 'long')} now={now} />. Check whether the caller needs a call back.</>,
      action: canOpenCalls ? <Link href={`/c/${clinicId}/calls/${c.id}`} className={LINK}>Open the call</Link> : null,
    })),
  ];
  const loading = calls.isPending || (canTasks && waiting.isPending);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Needs attention</CardTitle>
        {!loading && <span className="text-sm text-text-muted">{items.length ? `${items.length} item${items.length === 1 ? '' : 's'}` : 'All clear'}</span>}
      </CardHeader>
      {calls.isError && <Alert tone="danger" className="m-5">This list did not load. It tries again every {SAFETY_POLL_WORDS}.</Alert>}
      {loading ? <div className="space-y-3 p-5"><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
        : items.length === 0 ? (
          <Empty title="Nothing needs you right now" action={<Link href={`/c/${clinicId}/calls`} className="text-sm text-primary hover:underline">See the latest calls</Link>}>Emergencies from the last day, requests nobody has claimed, calls flagged for review, and calls that ended without an outcome appear here.</Empty>
        ) : (
          <ul className="divide-y divide-border" aria-label="Needs attention">
            {items.map((i) => (
              <li key={i.key} className={cn('flex items-center gap-3 px-5 py-3', i.tone === 'danger' && 'bg-danger-soft/50')}>
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-sunken" aria-hidden>{i.icon}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{i.title}</p>
                  <p className="text-xs text-text-muted">{i.detail}</p>
                </div>
                {i.action}
              </li>
            ))}
          </ul>
        )}
    </Card>
  );
}

function TodaysSchedule({ clinicId, clinic, now, today, schedule, allowed }: { clinicId: string; clinic: ClinicConfig; now: number; today: string; schedule: Q<Schedule>; allowed: boolean }) {
  const tz = clinic.timezone;
  const holiday = clinic.holidays.includes(today);
  const nowMin = localParts(new Date(now), tz).minutes;
  const visit = (id: string) => visitTypeName(clinic.visitTypes.find((v) => v.id === id)?.name ?? id);
  const clock = (m: number) => timeOf(new Date(Date.UTC(2000, 0, 1, Math.floor(m / 60), m % 60)), 'UTC');

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Today&apos;s schedule</CardTitle>
        {allowed && <Link href={`/c/${clinicId}/schedule`} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">Full schedule <ArrowRight className="size-3.5" /></Link>}
      </CardHeader>
      {!allowed ? <CardContent><p className="text-sm text-text-muted">Your role does not show the schedule, because it names patients.</p></CardContent>
        : holiday ? <Empty title="Closed today">The clinic is closed for a holiday. The assistant still answers and takes requests.</Empty>
          : schedule.isPending ? <div className="space-y-3 p-5"><Skeleton className="h-24" /></div>
            : schedule.isError ? <Alert tone="danger" className="m-5">Today&apos;s schedule did not load. It tries again every {SAFETY_POLL_WORDS}.</Alert> : (
              <div className="grid divide-y divide-border md:grid-cols-2 md:divide-x md:divide-y-0">
                {/* the stand-in a new clinic starts with steps aside once anyone else is listed, unless it has visits today */}
                {shownProviders(clinic.providers, (schedule.data?.appointments ?? []).filter((a) => holdsTime(a.status)).map((a) => a.providerId)).map((p) => {
                  const windows = bookableWindows(clinic, p, today).windows.map((w) => [toMinutes(w.open), toMinutes(w.close)] as const);
                  // what keeps the vet's time today: booked, arrived and completed (a no-show frees it)
                  const mine = (schedule.data?.appointments ?? []).filter((a) => a.providerId === p.id && holdsTime(a.status));
                  const span = mine.map((a) => ({ a, s: localParts(new Date(a.startsAt), tz).minutes, e: localParts(new Date(a.endsAt), tz).minutes }));
                  const next = span.find((x) => x.e > nowMin);
                  // open stretches of 20 minutes or more inside the provider's hours, from now on
                  const rows: { kind: 'visit' | 'gap'; s: number; e: number; a?: (typeof span)[number]['a'] }[] = [];
                  for (const [o, c] of windows) {
                    let cursor = o;
                    for (const x of span.filter((x) => x.s >= o && x.s < c)) {
                      if (x.s - Math.max(cursor, nowMin) >= 20) rows.push({ kind: 'gap', s: Math.max(cursor, nowMin), e: x.s });
                      rows.push({ kind: 'visit', s: x.s, e: x.e, a: x.a });
                      cursor = Math.max(cursor, x.e);
                    }
                    if (c - Math.max(cursor, nowMin) >= 20) rows.push({ kind: 'gap', s: Math.max(cursor, nowMin), e: c });
                  }
                  return (
                    <section key={p.id} className="px-5 py-4" aria-label={providerName(p)}>
                      <h3 className="mb-2 flex items-baseline justify-between text-sm font-semibold">
                        {/* the starter's placeholder is "our veterinarian": a heading starts with a capital */}
                        {providerName(p).charAt(0).toUpperCase() + providerName(p).slice(1)}
                        <span className="text-xs font-normal text-text-muted">{windows.length ? `${mine.length} booked` : ''}</span>
                      </h3>
                      {!windows.length ? <p className="text-sm text-text-muted">Not working today.</p> : !rows.length ? <p className="text-sm text-text-muted">Nothing left today.</p> : (
                        <ul className="space-y-1">
                          {rows.slice(0, 9).map((r) => r.kind === 'gap' ? (
                            // free time, from the next 5 minutes when it starts now
                            <li key={`gap-${r.s}`} className="rounded-md border border-dashed border-border px-2.5 py-1 text-xs text-text-muted">Free {clock(Math.min(r.e, Math.ceil(r.s / 5) * 5))} to {clock(r.e)}</li>
                          ) : (
                            <li key={r.a!.id}>
                              <Link href={`/c/${clinicId}/schedule?appointment=${r.a!.id}`}
                                className={cn('flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm hover:bg-surface-sunken', r.e <= nowMin && 'text-text-muted', next?.a.id === r.a!.id && 'bg-primary-soft font-medium ring-1 ring-primary/40')}>
                                <span className="w-[4.5rem] shrink-0 whitespace-nowrap tabular-nums text-text-muted">{clock(r.s)}</span>
                                <span className="min-w-0 flex-1 truncate">{r.a!.patientName || 'Booked visit'}</span>
                                <span className="shrink-0 text-xs text-text-muted">{next?.a.id === r.a!.id ? (r.s <= nowMin ? 'Now' : 'Next') : visit(r.a!.visitTypeId)}</span>
                              </Link>
                            </li>
                          ))}
                          {rows.length > 9 && <li className="px-2.5 text-xs text-text-muted">and {rows.length - 9} more on the full schedule</li>}
                        </ul>
                      )}
                    </section>
                  );
                })}
              </div>
            )}
    </Card>
  );
}

function AssistantDid({ overview, hosted }: { overview: Q<Overview>; hosted: boolean }) {
  const o = overview.data;
  const n = (v: number, f?: (x: number) => string) => <AnimatedNumber value={v} format={f} />;
  const rows: [string, (a: Overview['today']) => ReactNode][] = [
    ['Calls answered', (a) => n(a.callsAnswered)],
    ['Bookings made', (a) => n(a.booked)],
    ['Moved or cancelled', (a) => n(a.rescheduled + a.cancelled)],
    ['Requests taken', (a) => n(a.requestsTaken)],
    ['Handed to staff', (a) => n(a.handedToStaff)],
    ['After hours', (a) => n(a.afterHours)],
    ['Talk time', (a) => n(a.talkMinutes, (x) => `${x.toFixed(1).replace(/\.0$/, '')} min`)],
    // a hosted clinic pays a plan, not the voice minutes: the estimate is for people who run Attendra themselves
    ...(hosted ? [] : [['Estimated cost', (a: Overview['today']) => n(a.estimatedCost, usd)] as [string, (a: Overview['today']) => ReactNode]]),
  ];
  return (
    <Card>
      <CardHeader><CardTitle>What the assistant did</CardTitle></CardHeader>
      {overview.isError ? <Alert tone="danger" className="m-5">These numbers did not load. They try again every {SAFETY_POLL_WORDS}.</Alert> : !o ? <div className="p-5"><Skeleton className="h-48" /></div> : (
        <CardContent className="pt-2">
          <table className="w-full text-sm">
            <thead><tr className="text-xs text-text-muted"><th className="py-1.5 text-left font-medium"><span className="sr-only">Measure</span></th><th className="py-1.5 text-right font-medium">Today</th><th className="py-1.5 text-right font-medium">Last {o.days} days</th></tr></thead>
            <tbody>
              {rows.map(([label, value]) => (
                <tr key={label} className="border-t border-border">
                  <td className="py-1.5 text-text-muted">{label}</td>
                  <td className="py-1.5 text-right font-medium tabular-nums">{value(o.today)}</td>
                  <td className="py-1.5 text-right tabular-nums">{value(o.period)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-text-muted">Phone calls only; browser tests are not counted.{hosted ? '' : ` Cost is talk time at $${o.costPerMinute.toFixed(2)} a minute.`}</p>
        </CardContent>
      )}
    </Card>
  );
}

function RecentCalls({ clinicId, tz, calls, canOpen, canTest }: { clinicId: string; tz: string; calls: Q<CallList>; canOpen: boolean; canTest: boolean }) {
  const last = (calls.data?.calls ?? []).slice(0, 5);
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Recent calls</CardTitle>
        <Link href={`/c/${clinicId}/calls`} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">All calls <ArrowRight className="size-3.5" /></Link>
      </CardHeader>
      {calls.isPending ? <div className="space-y-2 p-5"><Skeleton className="h-8" /><Skeleton className="h-8" /></div>
        : !last.length ? <Empty title="No calls yet" action={canTest ? <Link href={`/c/${clinicId}/test-call`} className="text-sm text-primary hover:underline">Try a test call</Link> : undefined}>Calls appear here as soon as the assistant answers one.</Empty> : (
          <ul className="divide-y divide-border" aria-label="Recent calls">
            {last.map((c) => {
              const body = (
                <>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium tabular-nums">{new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date(c.startedAt))} {timeOf(c.startedAt, tz)}</p>
                    <p className="truncate text-xs text-text-muted">{c.tools.map((t) => TOOLS[t] ?? t).join(', ') || 'Talked only'}</p>
                  </div>
                  <Outcome outcome={c.outcome} emergency={c.emergency} emergencyResult={c.emergencyResult} />
                </>
              );
              return <li key={c.id}>{canOpen ? <Link href={`/c/${clinicId}/calls/${c.id}`} className="flex items-center gap-3 px-5 py-2.5 hover:bg-surface-sunken">{body}</Link> : <div className="flex items-center gap-3 px-5 py-2.5">{body}</div>}</li>;
            })}
          </ul>
        )}
    </Card>
  );
}
