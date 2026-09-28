// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { Task, TaskList } from '@attendra/api/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Hand, Phone, Pill } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { PageHeader } from '@/components/shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Alert, Empty, Skeleton } from '@/components/ui/feedback';
import { api, ApiFailure, useClinic } from '@/lib/api';
import { clinicTime, TASK_TYPES } from '@/lib/format';

const DETAIL_LABELS: Record<string, string> = { medication: 'Medication', pharmacy: 'Pharmacy', callback_number: 'Call back on', reason: 'Reason' };

function phone(e164: string) {
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export default function Tasks() {
  const { clinicId } = useParams<{ clinicId: string }>();
  const { clinic, data: me, can } = useClinic(clinicId);
  const [status, setStatus] = useState<'open' | 'done'>('open');
  const [conflict, setConflict] = useState<string | null>(null);
  const queries = useQueryClient();
  const tasks = useQuery({
    queryKey: ['tasks', clinicId, status],
    queryFn: () => api<TaskList>(`/clinics/${clinicId}/tasks?status=${status}`),
    refetchInterval: 30_000,
  });
  const act = useMutation({
    mutationFn: ({ task, action }: { task: Task; action: 'claim' | 'done' | 'release' }) => api<void>(`/clinics/${clinicId}/tasks/${task.id}/${action}`, { method: 'POST' }),
    onMutate: () => setConflict(null),
    onError: (e) => { if (e instanceof ApiFailure && e.status === 409) setConflict(e.body.message ?? 'Someone else has this task.'); },
    onSettled: () => queries.invalidateQueries({ queryKey: ['tasks', clinicId] }),
  });
  const tz = clinic?.timezone ?? 'UTC';
  const mine = (t: Task) => t.assigneeUserId === me?.user.id;

  return (
    <>
      <PageHeader title="Tasks" description="Refill requests and callbacks the assistant took down. It never approves a refill; that stays with your team." />
      <div className="mb-4 flex gap-2" role="tablist">
        {(['open', 'done'] as const).map((s) => (
          <Button key={s} size="sm" role="tab" aria-selected={status === s} variant={status === s ? 'primary' : 'outline'} onClick={() => setStatus(s)}>{s === 'open' ? 'Open' : 'Done'}</Button>
        ))}
      </div>
      {conflict && <Alert tone="warn" className="mb-4">{conflict}</Alert>}
      {tasks.isPending ? <Skeleton className="h-40" /> : !tasks.data?.tasks.length ? (
        <Card><Empty title={status === 'open' ? 'Nothing waiting' : 'Nothing closed yet'}>{status === 'open' ? 'New requests from calls show up here.' : 'Tasks you mark done are listed here.'}</Empty></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {tasks.data.tasks.map((t) => {
            const Icon = t.type === 'refill' ? Pill : Phone;
            const heldByOther = !!t.assigneeUserId && !mine(t);
            return (
              <Card key={t.id} className="flex flex-col" data-testid="task">
                <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
                  <div className="flex items-center gap-3">
                    <span className="flex size-9 items-center justify-center rounded-full bg-accent text-primary"><Icon className="size-4" /></span>
                    <div>
                      <p className="font-medium">{t.patientName ?? 'Caller not verified'}</p>
                      <p className="text-xs text-muted-foreground">{TASK_TYPES[t.type]} · {clinicTime(t.createdAt, tz)}</p>
                    </div>
                  </div>
                  {t.status === 'done'
                    ? <Badge tone="ok">Done</Badge>
                    : t.assigneeUserId ? <Badge tone="accent"><Hand /> {mine(t) ? 'You have it' : 'Taken'}</Badge> : <Badge tone="warn">Unclaimed</Badge>}
                </div>
                <dl className="grid flex-1 grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-5 py-4 text-sm">
                  {Object.entries(t.details).map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-muted-foreground">{DETAIL_LABELS[k] ?? k}</dt>
                      <dd>{k === 'callback_number' ? <a className="hover:underline" href={`tel:${v}`}>{phone(v)}</a> : v}</dd>
                    </div>
                  ))}
                </dl>
                <div className="flex items-center justify-between gap-2 border-t border-border px-5 py-3">
                  {t.callId ? <Link href={`/c/${clinicId}/calls/${t.callId}`} className="text-sm text-muted-foreground hover:text-foreground hover:underline">Open the call</Link> : <span />}
                  {t.status === 'open' && can('tasks:work') && (
                    <div className="flex gap-2">
                      {!t.assigneeUserId && <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate({ task: t, action: 'claim' })}>Claim</Button>}
                      {t.assigneeUserId && (mine(t) || can('tasks:reassign')) && <Button size="sm" variant="ghost" disabled={act.isPending} onClick={() => act.mutate({ task: t, action: 'release' })}>Release</Button>}
                      {!heldByOther && <Button size="sm" disabled={act.isPending} onClick={() => act.mutate({ task: t, action: 'done' })}>Mark done</Button>}
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
