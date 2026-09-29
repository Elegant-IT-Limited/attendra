// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { CallDetail } from '@attendra/api/contracts';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Bot, Check, Lock, User, X } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Outcome } from '@/components/calls/outcome';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, Empty, Skeleton } from '@/components/ui/feedback';
import { api, ApiFailure, useClinic } from '@/lib/api';
import { clinicTime, clock, duration, REFUSALS, TASK_TYPES, TOOLS } from '@/lib/format';
import { cn } from '@/lib/utils';

const CLOSE_REASONS: Record<string, string> = {
  caller_hangup: 'Caller hung up', transferred: 'Transferred', agent_hangup: 'Assistant ended the call', connection_lost: 'Connection dropped',
};

export default function CallPage() {
  const { clinicId, callId } = useParams<{ clinicId: string; callId: string }>();
  const { clinic } = useClinic(clinicId);
  const call = useQuery({ queryKey: ['call', clinicId, callId], queryFn: () => api<CallDetail>(`/clinics/${clinicId}/calls/${callId}`) });
  const tz = clinic?.timezone ?? 'UTC';

  const back = (
    <Link href={`/c/${clinicId}/calls`} className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="size-4" /> All calls
    </Link>
  );
  if (call.isPending) return <>{back}<Skeleton className="h-8 w-72" /><Skeleton className="mt-6 h-96" /></>;
  if (call.isError || !call.data) {
    const missing = call.error instanceof ApiFailure && call.error.status === 404;
    return <>{back}<Empty title={missing ? 'Call not found' : 'This call did not load'}>{missing ? 'It may belong to another clinic.' : 'Try again in a moment.'}</Empty></>;
  }
  const c = call.data;

  return (
    <>
      {back}
      <div className="mb-6 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{clinicTime(c.startedAt, tz, 'long')}</h1>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Outcome outcome={c.outcome} emergency={c.emergency} />
          {c.channel === 'web' && <Badge tone="accent">Browser test</Badge>}
          <span>{duration(c.voiceSeconds)}</span>
          {c.closeReason && <span>· {CLOSE_REASONS[c.closeReason] ?? c.closeReason}</span>}
        </div>
      </div>
      {c.emergency && (
        <Alert tone="danger" title="Emergency language on this call" className="mb-6">
          The assistant stopped what it was doing and gave the emergency script. Review the call and follow up as your protocol says.
        </Alert>
      )}
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Transcript</CardTitle>
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Lock className="size-3" /> Your view is in the audit log</span>
          </CardHeader>
          <CardContent className="space-y-4">
            {c.transcript.length === 0 && <p className="text-sm text-muted-foreground">No speech was recorded on this call.</p>}
            {c.transcript.map((s, i) => {
              const agent = s.speaker === 'agent';
              return (
                <div key={i} className={cn('flex gap-3', !agent && 'flex-row-reverse')}>
                  <div className={cn('flex size-8 shrink-0 items-center justify-center rounded-full', agent ? 'bg-accent text-primary' : 'bg-muted text-muted-foreground')}>
                    {agent ? <Bot className="size-4" /> : <User className="size-4" />}
                  </div>
                  <div className={cn('max-w-[80%] space-y-1', !agent && 'text-right')}>
                    <p className="text-xs text-muted-foreground">{agent ? 'Assistant' : 'Caller'} · {clock(s.startMs)}</p>
                    <p className={cn('inline-block rounded-lg px-3.5 py-2 text-left text-sm leading-relaxed', agent ? 'bg-muted' : 'bg-primary text-primary-foreground')}>{s.text}</p>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>What the assistant did</CardTitle></CardHeader>
            <CardContent>
              {c.actions.length === 0 ? <p className="text-sm text-muted-foreground">It answered without using any tools.</p> : (
                <ol className="space-y-3">
                  {c.actions.map((a, i) => {
                    const error = typeof a.result.error === 'string' ? a.result.error : null;
                    return (
                      <li key={i} className="flex gap-3 text-sm">
                        <span className={cn('mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full', error ? 'bg-warn-soft' : 'bg-ok-soft')}>
                          {error ? <X className="size-3" /> : <Check className="size-3" />}
                        </span>
                        <div>
                          <p className="font-medium">{TOOLS[a.tool] ?? a.tool}</p>
                          <p className="text-xs text-muted-foreground">
                            {error ? (REFUSALS[error] ?? error) : a.result.booked ? 'booked' : a.result.cancelled ? 'cancelled' : a.result.verified ? 'verified' : 'done'}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
              <p className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
                Only argument names are stored here, never the values a caller said. The transcript holds what was said.
              </p>
            </CardContent>
          </Card>
          {c.tasks.length > 0 && (
            <Card>
              <CardHeader><CardTitle>Left for staff</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {c.tasks.map((t) => (
                  <Link key={t.id} href={`/c/${clinicId}/tasks`} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm hover:bg-muted">
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
