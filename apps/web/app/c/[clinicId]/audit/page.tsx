// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { AuditList } from '@attendra/api/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Empty, Skeleton } from '@/components/ui/feedback';
import { Table, TD, TH, THead, TRow } from '@/components/ui/table';
import { api, useClinic } from '@/lib/api';
import { clinicTime } from '@/lib/format';

const ACTIONS: Record<string, string> = {
  'call.transcript.viewed': 'Read a call transcript',
  'task.viewed': 'Viewed a task',
  'task.claimed': 'Claimed a task',
  'task.done': 'Closed a task',
  'task.created.refill': 'Took a refill request',
  'task.created.callback': 'Took a callback request',
  'patient.identified': 'Verified a caller',
  'clinic.settings.updated': 'Changed clinic settings',
};

function actor(a: string, meId?: string) {
  if (a === 'voice-agent') return <Badge tone="accent">Assistant</Badge>;
  if (a.startsWith('user:')) return <span>{a.slice(5) === meId ? 'You' : 'Staff member'} <span className="font-mono text-xs text-muted-foreground">{a.slice(5, 13)}</span></span>;
  return <span className="text-muted-foreground">{a}</span>;
}

export default function Audit() {
  const { clinicId } = useParams<{ clinicId: string }>();
  const { clinic, data: me } = useClinic(clinicId);
  const entries = useInfiniteQuery({
    queryKey: ['audit', clinicId],
    queryFn: ({ pageParam }) => api<AuditList>(`/clinics/${clinicId}/audit?limit=100${pageParam ? `&before=${pageParam}` : ''}`),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.next,
  });
  const rows = entries.data?.pages.flatMap((p) => p.entries) ?? [];
  const tz = clinic?.timezone ?? 'UTC';

  return (
    <>
      <PageHeader title="Audit log" description="Every time someone, or the assistant, looked at patient data or changed something. Rows can be added, never edited or removed." />
      <Card>
        {entries.isPending ? <div className="space-y-3 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-8" />)}</div>
          : rows.length === 0 ? <Empty title="Nothing recorded yet" />
            : (
              <Table>
                <THead><tr><TH>When</TH><TH>Who</TH><TH>What</TH><TH className="hidden md:table-cell">Record</TH></tr></THead>
                <tbody>
                  {rows.map((e) => (
                    <TRow key={e.id}>
                      <TD className="whitespace-nowrap">{clinicTime(e.at, tz)}</TD>
                      <TD>{actor(e.actor, me?.user.id)}</TD>
                      <TD>{ACTIONS[e.action] ?? e.action}</TD>
                      <TD className="hidden text-muted-foreground md:table-cell">
                        {e.callId ? <Link href={`/c/${clinicId}/calls/${e.callId}`} className="hover:underline">call</Link> : e.entity}
                        {e.entityId && <span className="ml-2 font-mono text-xs">{e.entityId.slice(0, 8)}</span>}
                      </TD>
                    </TRow>
                  ))}
                </tbody>
              </Table>
            )}
      </Card>
      {entries.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" onClick={() => entries.fetchNextPage()} disabled={entries.isFetchingNextPage}>Older entries</Button>
        </div>
      )}
    </>
  );
}
