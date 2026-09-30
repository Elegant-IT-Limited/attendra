// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { CallDetail } from '@attendra/api/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ArrowLeft, Bot, CalendarCheck, CalendarX, Check, Lock, User, UserCheck, X } from 'lucide-react';
import { localDateOf } from '@attendra/core';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Outcome } from '@/components/calls/outcome';
import { SummaryCard } from '@/components/calls/summary-card';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, Empty, Skeleton } from '@/components/ui/feedback';
import { api, ApiFailure, useClinic, useClinicConfig } from '@/lib/api';
import { clinicTime, clock, duration, REFUSALS, shortWhen, TASK_TYPES, TOOLS } from '@/lib/format';
import { cn } from '@/lib/utils';

const CLOSE_REASONS: Record<string, string> = {
  caller_hangup: 'Caller hung up', transferred: 'Transferred', agent_hangup: 'Assistant ended the call', ended_by_staff: 'Ended by staff', connection_lost: 'Connection dropped',
};

const SUMMARY_POLL_MS = 5_000;
const SUMMARY_WAIT_MS = 120_000;
/** A summary is on its way: the call has no summary yet, its job has not failed, and it is not an old call that never had one. */
function summaryPending(c: CallDetail) {
  if (c.summary || c.summaryJob?.state === 'failed') return false;
  if (!c.endedAt) return true; // just ended: the record catches up in a moment
  return !!c.summaryJob || Date.now() - Date.parse(c.endedAt) < 10 * 60_000;
}

export default function CallPage() {
  const { clinicId, callId } = useParams<{ clinicId: string; callId: string }>();
  const { clinic, can, isPending: meLoading } = useClinic(clinicId);
  const config = useClinicConfig(clinicId);
  // until the worker has written the summary, look again every 5 seconds, for up to 2 minutes
  const [opened] = useState(() => Date.now());
  const [now, setNow] = useState(opened);
  const call = useQuery({
    queryKey: ['call', clinicId, callId], queryFn: () => api<CallDetail>(`/clinics/${clinicId}/calls/${callId}`),
    refetchOnMount: 'always',
    enabled: can('calls:read'),
    refetchInterval: (q) => {
      const c = q.state.data;
      if (!c || !summaryPending(c)) return false;
      return Date.now() - opened < SUMMARY_WAIT_MS ? SUMMARY_POLL_MS : false;
    },
  });
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), SUMMARY_POLL_MS); return () => clearInterval(t); }, []);
  const slowSummary = !!call.data && summaryPending(call.data) && now - opened >= SUMMARY_WAIT_MS;
  const tz = clinic?.timezone ?? 'UTC';

  const back = (
    <Link href={`/c/${clinicId}/calls`} className="mb-4 inline-flex items-center gap-1 text-sm text-text-muted hover:text-text">
      <ArrowLeft className="size-4" /> All calls
    </Link>
  );
  if (!meLoading && !can('calls:read')) {
    return <>{back}<Card><Empty title="Call records are for the front desk">Your role sees the call list, not what was said on a call. Ask a practice manager if you need more.</Empty></Card></>;
  }
  if (call.isPending) return <>{back}<Skeleton className="h-8 w-72" /><Skeleton className="mt-6 h-96" /></>;
  if (call.isError || !call.data) {
    const missing = call.error instanceof ApiFailure && call.error.status === 404;
    return <>{back}<Empty title={missing ? 'Call not found' : 'This call did not load'}>{missing ? 'It may belong to another clinic.' : 'Try again in a moment.'}</Empty></>;
  }
  const c = call.data;
  // what the call booked may have changed since: the header says so when none of it stands
  const bookedHere = c.appointments.filter((a) => a.change === 'booked');
  const allCancelled = bookedHere.length > 0 && bookedHere.every((a) => a.status === 'cancelled');

  return (
    <>
      {back}
      <div className="mb-6 space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">{clinicTime(c.startedAt, tz, 'long')}</h1>
        <div className="flex flex-wrap items-center gap-2 text-sm text-text-muted">
          <Outcome outcome={c.outcome} emergency={c.emergency} />
          {allCancelled && <Badge tone="warn">Booking since cancelled</Badge>}
          {c.channel === 'web' && <Badge tone="accent">Browser test</Badge>}
          <span>{duration(c.voiceSeconds)}</span>
          {c.closeReason && <span>· {CLOSE_REASONS[c.closeReason] ?? c.closeReason}</span>}
        </div>
      </div>
      {c.appointments.length > 0 && (
        <ul className="mb-6 space-y-2">
          {c.appointments.map((a) => {
            const Icon = a.change === 'booked' ? CalendarCheck : CalendarX;
            const provider = config.data?.providers.find((p) => p.id === a.providerId)?.name ?? 'the provider';
            const line = `${a.change === 'booked' ? 'Booked' : 'Cancelled'}: ${shortWhen(a.startsAt, tz)} with ${provider}`;
            return (
              <li key={a.id} className="flex flex-wrap items-center gap-2 text-sm">
                <Icon className="size-4 text-primary" aria-hidden />
                {can('schedule:read')
                  ? <Link href={`/c/${clinicId}/schedule?date=${localDateOf(new Date(a.startsAt), tz)}&appointment=${a.id}`} className="font-medium hover:underline">{line}</Link>
                  : <span className="font-medium">{line}</span>}
                {a.change === 'booked' && a.status === 'cancelled' && <Badge>Since cancelled</Badge>}
                {a.change === 'booked' && a.status === 'booked' && a.moved && <Badge>Since moved</Badge>}
              </li>
            );
          })}
        </ul>
      )}
      {c.emergency && (
        <Alert tone="danger" title="Emergency language on this call" className="mb-6">
          The assistant stopped what it was doing and gave the emergency script. Review the call and follow up as your protocol says.
        </Alert>
      )}
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Transcript</CardTitle>
            <span className="inline-flex items-center gap-1 text-xs text-text-muted"><Lock className="size-3" /> Your view is in the audit log</span>
          </CardHeader>
          <CardContent className="space-y-4">
            {c.transcript.length === 0 && <p className="text-sm text-text-muted">No speech was recorded on this call.</p>}
            {c.transcript.map((s, i) => {
              const agent = s.speaker === 'agent';
              return (
                <div key={i} className={cn('flex gap-3', !agent && 'flex-row-reverse')}>
                  <div className={cn('flex size-8 shrink-0 items-center justify-center rounded-full', agent ? 'bg-primary-soft text-primary' : 'bg-surface-sunken text-text-muted')}>
                    {agent ? <Bot className="size-4" /> : <User className="size-4" />}
                  </div>
                  <div className={cn('max-w-[80%] space-y-1', !agent && 'text-right')}>
                    <p className="text-xs text-text-muted">{agent ? 'Assistant' : 'Caller'} · {clock(s.startMs)}</p>
                    <p className={cn('inline-block rounded-lg px-3.5 py-2 text-left text-sm leading-relaxed', agent ? 'bg-surface-sunken' : 'bg-primary text-on-primary')}>{s.text}</p>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
        <div className="space-y-6">
          <SummaryCard clinicId={clinicId} call={c} canReview={can('calls:read')} slow={slowSummary} />
          <Card>
            <CardHeader><CardTitle>Who&apos;s calling</CardTitle></CardHeader>
            <CardContent className="text-sm">
              {c.patient ? (
                <div className="flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-2"><UserCheck className="size-4 text-primary" aria-hidden />
                    {can('patients:read') ? <Link href={`/c/${clinicId}/patients/${c.patient.id}`} className="font-medium hover:underline">{c.patient.name}</Link> : <span className="font-medium">{c.patient.name}</span>}
                  </span>
                  <Badge tone="ok">Verified</Badge>
                </div>
              ) : <p className="text-text-muted">Not verified. The assistant links a call to a patient only after checking their name and date of birth.</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>What the assistant did</CardTitle></CardHeader>
            <CardContent>
              {c.actions.length === 0 ? <p className="text-sm text-text-muted">It answered without using any tools.</p> : (
                <ol className="space-y-3">
                  {c.actions.map((a, i) => {
                    const error = typeof a.result.error === 'string' ? a.result.error : null;
                    return (
                      <li key={i} className="flex gap-3 text-sm">
                        <span className={cn('mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full', error ? 'bg-warning-soft' : 'bg-success-soft')}>
                          {error ? <X className="size-3" /> : <Check className="size-3" />}
                        </span>
                        <div>
                          <p className="font-medium">{TOOLS[a.tool] ?? a.tool}</p>
                          <p className="text-xs text-text-muted">
                            {error ? (REFUSALS[error] ?? error) : a.result.booked ? 'booked' : a.result.cancelled ? 'cancelled' : a.result.verified ? 'verified' : 'done'}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
              <p className="mt-4 border-t border-border pt-3 text-xs text-text-muted">
                Only argument names are stored here, never the values a caller said. The transcript holds what was said.
              </p>
            </CardContent>
          </Card>
          {c.tasks.length > 0 && (
            <Card>
              <CardHeader><CardTitle>Requests for the team</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {c.tasks.map((t) => (
                  <Link key={t.id} href={`/c/${clinicId}/requests${t.status === 'open' ? '' : '?status=done'}`} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-sunken">
                    <span>{TASK_TYPES[t.type] ?? t.type}</span>
                    <Badge tone={t.status === 'open' ? 'warn' : 'ok'}>{t.status === 'open' ? 'Open' : 'Done'}</Badge>
                  </Link>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
