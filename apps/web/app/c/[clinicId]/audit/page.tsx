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
import { api, useClinic, useClinicConfig } from '@/lib/api';
import { clinicTime, dayTitle, zoneLabel } from '@/lib/format';

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
  'member.removed': 'Removed a person from the team',
  'member.password.reset': 'Issued a new temporary password',
  'patient.search.result': 'Saw a patient in search results',
  'call.live.watched': 'Watched a live call',
  'calls.live.listed': 'Looked at live calls with names',
  'call.coached': 'Sent the assistant a note',
  'call.taken_over': 'Took over a live call',
  'call.ended_by_staff': 'Ended a live call',
  'api_key.created': 'Made an API key',
  'api_key.revoked': 'Revoked an API key',
  'member.transfer_number.set': 'Set their number for take-overs',
  'member.transfer_number.cleared': 'Cleared their number for take-overs',
  'retention.purged': 'Deleted old call records',
  'call.summary.reviewed': 'Marked a call summary reviewed',
};

const ROLE_WORDS: Record<string, string> = { owner: 'owner', admin: 'practice manager', staff: 'front desk', viewer: 'viewer' };

// actions that carry a detail after the last dot: sms.sent.<template>, call.transferred.<target>
function describe(action: string) {
  if (ACTIONS[action]) return ACTIONS[action];
  if (action.startsWith('sms.sent.')) return 'Sent a text confirmation';
  if (action.startsWith('member.added:')) return `Added a person to the team, as ${ROLE_WORDS[action.slice(13)] ?? action.slice(13)}`;
  if (action.startsWith('member.role.changed:')) return `Changed someone's role to ${ROLE_WORDS[action.slice(20)] ?? action.slice(20)}`;
  if (action.startsWith('call.transferred.')) return `Transferred the call (${action.slice(17).replace('_', ' ')})`;
  return action;
}

function actor(a: string, meId: string | undefined, names: Map<string, string>) {
  if (a === 'voice-agent') return <Badge tone="accent">Assistant</Badge>;
  if (a.startsWith('user:')) {
    const id = a.slice(5);
    if (id === meId) return <span>You</span>;
    return names.has(id) ? <span>{names.get(id)}</span> : <span>A former team member <span className="font-mono text-xs text-text-muted">{id.slice(0, 8)}</span></span>;
  }
  return <span className="text-text-muted">{a}</span>;
}

const ENTITIES: Record<string, string> = {
  call: 'Call', patient: 'Patient', task: 'Request', appointment: 'Appointment', clinic: 'Clinic', member: 'Team member',
  api_key: 'API key', webhook_endpoint: 'Webhook endpoint', schedule: 'Schedule', knowledge_document: 'Document',
};
const LISTS: Record<string, string> = { 'calls.listed': 'Call list', 'calls.live.listed': 'Live calls', 'patient.recent.viewed': 'Recent patients', 'calls.searched': 'Call search', 'patient.searched': 'Patient search' };
// "29 Sep", the dashboard's own day-first format, whatever the browser's locale
const day = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? dayTitle(iso, 'short').replace(/^\w+ /, '') : iso);

/**
 * The Record column in plain words: "Schedule, 29 Sep, all providers", "Call list",
 * "Patient search, 3 found". The keys behind them (filters, a hash of who was on
 * screen) are for telling views apart, not for reading.
 */
function record(e: { action: string; entity: string; entityId: string | null; counts?: Record<string, number> | null }, providers: Map<string, string>): string {
  const what = LISTS[e.action] ?? ENTITIES[e.entity] ?? e.entity;
  const id = e.entityId ?? '';
  if (id.startsWith('matches:')) return `${what}, ${id.slice(8)} found`;
  if (e.entity === 'schedule') {
    const [range = '', provider = ''] = id.split(';');
    const [from = '', days = '1'] = range.split('+');
    const who = provider.replace(/^provider=/, '');
    return `${what}, ${days === '1' ? day(from) : `${days} days from ${day(from)}`}, ${!who || who === 'all' ? 'all providers' : providers.get(who) ?? 'one provider'}`;
  }
  if (e.action === 'call.taken_over' && e.counts) {
    const to = e.counts.ownNumber ? 'their own number' : 'the front desk';
    return `${what}, to ${to}${e.counts.destinationLast4 !== undefined ? ` ending ${String(e.counts.destinationLast4).padStart(4, '0')}` : ''}`;
  }
  return what;
}

export default function Audit() {
  const { clinicId } = useParams<{ clinicId: string }>();
  const { clinic, data: me, can, isPending: meLoading } = useClinic(clinicId);
  const allowed = can('audit:read');
  const team = useQuery({ queryKey: ['members', clinicId], queryFn: () => api<MemberList>(`/clinics/${clinicId}/members`), enabled: can('members:manage') });
  const names = new Map((team.data?.members ?? []).map((m) => [m.userId, m.name]));
  const config = useClinicConfig(clinicId);
  const providers = new Map((config.data?.providers ?? []).map((p) => [p.id, p.name]));
  const entries = useInfiniteQuery({
    queryKey: ['audit', clinicId],
    queryFn: ({ pageParam }) => api<AuditList>(`/clinics/${clinicId}/audit?limit=100${pageParam ? `&before=${pageParam}` : ''}`),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.next,
    enabled: allowed,
  });
  const rows = entries.data?.pages.flatMap((p) => p.entries) ?? [];
  const tz = clinic?.timezone ?? 'UTC';

  if (!meLoading && !allowed) {
    return <><PageHeader title="Audit log" /><Card><Empty title="Not available">Only owners and practice managers read the audit log.</Empty></Card></>;
  }

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
                      <TD className="hidden text-text-muted md:table-cell">
                        {e.callId ? <Link href={`/c/${clinicId}/calls/${e.callId}`} className="hover:underline">{record(e, providers)}</Link> : record(e, providers)}
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
