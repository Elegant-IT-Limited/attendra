// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { AuditList, MemberList } from '@attendra/api/contracts';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Alert, Empty, Skeleton } from '@/components/ui/feedback';
import { Table, TD, TH, THead, TRow } from '@/components/ui/table';
import { api, useClinic } from '@/lib/api';
import { clinicTime, zoneLabel } from '@/lib/format';

const ACTIONS: Record<string, string> = {
  'call.transcript.viewed': 'Read a call transcript',
  'call.test.started': 'Started a browser test call',
  'task.viewed': 'Viewed a request',
  'task.claimed': 'Claimed a request',
  'task.done': 'Closed a request',
  'task.created.refill': 'Took a refill request',
  'task.created.callback': 'Took a callback request',
  'patient.identified': 'Verified a caller',
  'clinic.settings.updated': 'Changed clinic settings',
  'appointment.booked': 'Booked an appointment',
  'appointment.cancelled': 'Cancelled an appointment',
  'task.released': 'Released a request',
  'task.released.override': 'Released someone else\'s request',
  'task.created.voicemail': 'Took a voicemail',
  'task.assigned': 'Handed a request to a teammate',
  'task.note.added': 'Added a note to a request',
  'schedule.viewed': 'Looked at the schedule',
  'appointment.viewed': 'Opened an appointment',
  'appointment.booked.staff': 'Booked an appointment at the desk',
  'appointment.rescheduled.staff': 'Moved an appointment',
  'appointment.cancelled.staff': 'Cancelled an appointment at the desk',
  'patient.searched': 'Searched for a patient',
  'patient.viewed': 'Opened a patient\'s record',
  'patient.recent.viewed': 'Looked at recent patients',
  'patient.created': 'Added a patient',
  'patient.updated': 'Changed a patient\'s details',
  'calls.listed': 'Looked at the call list with names',
  'calls.searched': 'Searched calls by patient',
  'member.added': 'Added a person to the team',
  'member.role.changed': 'Changed someone\'s role',
  'member.removed': 'Removed a person from the team',
};

// actions that carry a detail after the last dot: sms.sent.<template>, call.transferred.<target>
function describe(action: string) {
  if (ACTIONS[action]) return ACTIONS[action];
  if (action.startsWith('sms.sent.')) return 'Sent a text confirmation';
  if (action.startsWith('call.transferred.')) return `Transferred the call (${action.slice(17).replace('_', ' ')})`;
  return action;
}

function actor(a: string, meId: string | undefined, names: Map<string, string>) {
  if (a === 'voice-agent') return <Badge tone="accent">Assistant</Badge>;
  if (a.startsWith('user:')) {
    const id = a.slice(5);
    if (id === meId) return <span>You</span>;
    return names.has(id) ? <span>{names.get(id)}</span> : <span>A former team member <span className="font-mono text-xs text-muted-foreground">{id.slice(0, 8)}</span></span>;
  }
  return <span className="text-muted-foreground">{a}</span>;
}

// "matches:3" on a search: how many were found, never what was typed
function record(e: { entity: string; entityId: string | null }) {
  if (e.entityId?.startsWith('matches:')) return `${e.entityId.slice(8)} found`;
  if (e.entity === 'schedule' && e.entityId) { const [from, days] = e.entityId.split('+'); return `${days === '1' ? 'the day' : `${days} days from`} ${from}`; }
  return null;
}

export default function Audit() {
  const { clinicId } = useParams<{ clinicId: string }>();
  const { clinic, data: me, can } = useClinic(clinicId);
  const team = useQuery({ queryKey: ['members', clinicId], queryFn: () => api<MemberList>(`/clinics/${clinicId}/members`), enabled: can('members:manage') });
  const names = new Map((team.data?.members ?? []).map((m) => [m.userId, m.name]));
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
      <PageHeader title="Audit log" description={<>Every time someone, or the assistant, looked at patient data or changed something. Rows can be added, never edited or removed. Times are {zoneLabel(tz)}.</>} />
      <Card>
        {entries.isPending ? <div className="space-y-3 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-8" />)}</div>
          : entries.isError ? <Alert tone="danger" className="m-4">The audit log did not load. Refresh the page to try again.</Alert>
          : rows.length === 0 ? <Empty title="Nothing recorded yet">Views of patient data and every change appear here as they happen.</Empty>
            : (
              <Table>
                <THead><tr><TH>When</TH><TH>Who</TH><TH>What</TH><TH className="hidden md:table-cell">Record</TH></tr></THead>
                <tbody>
                  {rows.map((e) => (
                    <TRow key={e.id}>
                      <TD className="whitespace-nowrap">{clinicTime(e.at, tz)}</TD>
                      <TD>{actor(e.actor, me?.user.id, names)}</TD>
                      <TD>{describe(e.action)}</TD>
                      <TD className="hidden text-muted-foreground md:table-cell">
                        {e.callId ? <Link href={`/c/${clinicId}/calls/${e.callId}`} className="hover:underline">call</Link> : e.entity}
                        {record(e) ? <span className="ml-2 text-xs">{record(e)}</span> : e.entityId && <span className="ml-2 font-mono text-xs">{e.entityId.slice(0, 8)}</span>}
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
