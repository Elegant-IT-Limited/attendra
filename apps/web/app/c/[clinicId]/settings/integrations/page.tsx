// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { WebhookAttempt, WebhookAttempts, WebhookEndpoint, WebhookEndpoints, WebhookSecret } from '@attendra/api/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Plus, RotateCcw, Send, Trash2, Webhook } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Field } from '@/components/settings/section';
import { SettingsNav } from '@/components/settings/settings-nav';
import { PageHeader } from '@/components/shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox, Switch } from '@/components/ui/controls';
import { Panel } from '@/components/ui/dialog';
import { Alert, Empty, Skeleton } from '@/components/ui/feedback';
import { Input } from '@/components/ui/input';
import { Table, TD, TH, THead, TRow } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, ApiFailure, useClinic } from '@/lib/api';
import { clinicTime } from '@/lib/format';

export const EVENTS: { type: WebhookEndpoint['events'][number]; label: string }[] = [
  { type: 'call.completed', label: 'A call ended' },
  { type: 'call.summary.ready', label: 'A call summary is ready' },
  { type: 'appointment.booked', label: 'An appointment was booked' },
  { type: 'appointment.rescheduled', label: 'An appointment was moved' },
  { type: 'appointment.cancelled', label: 'An appointment was cancelled' },
  { type: 'request.created', label: 'A request came in' },
  { type: 'request.done', label: 'A request was closed' },
];
const ERRORS: Record<string, string> = {
  private_address: 'blocked: private address', https_only: 'blocked: not https', unresolvable: 'name does not resolve', timeout: 'timed out', connection_failed: 'could not connect',
};
const outcome = (a: Pick<WebhookAttempt, 'statusCode' | 'error' | 'durationMs'>) =>
  a.error ? `${a.statusCode ? `${a.statusCode}, ` : ''}${ERRORS[a.error] ?? a.error.replace(/_/g, ' ')}` : `${a.statusCode} in ${a.durationMs} ms`;

/** The secret, shown once, with a way to copy it. */
function SecretPanel({ shown, onClose }: { shown: WebhookSecret | null; onClose: () => void }) {
  const toast = useToast();
  return (
    <Panel open={!!shown} onOpenChange={(o) => !o && onClose()} title="Copy the signing secret" description="Your receiver checks every delivery with it. You will not see it again."
      footer={<Button onClick={onClose}>Done</Button>}>
      <div className="space-y-3">
        <code className="block break-all rounded-md border border-border bg-surface-sunken px-3 py-2 font-mono text-sm" data-testid="webhook-secret">{shown?.secret}</code>
        <Button variant="outline" size="sm" onClick={() => { void navigator.clipboard?.writeText(shown?.secret ?? '').then(() => toast({ tone: 'success', message: 'Copied.' }), () => {}); }}><Copy /> Copy</Button>
        <p className="text-sm text-text-muted">docs/webhooks.md shows how to check the signature in TypeScript and Python, and how to connect n8n.</p>
      </div>
    </Panel>
  );
}

function DeliveryLog({ clinicId, endpoint, tz }: { clinicId: string; endpoint: WebhookEndpoint; tz: string }) {
  const queries = useQueryClient();
  const toast = useToast();
  const log = useQuery({ queryKey: ['webhook-attempts', clinicId, endpoint.id], queryFn: () => api<WebhookAttempts>(`/clinics/${clinicId}/webhooks/${endpoint.id}/attempts`), refetchInterval: 10_000 });
  const redeliver = useMutation({
    mutationFn: (a: WebhookAttempt) => api<WebhookAttempt>(`/clinics/${clinicId}/webhooks/${endpoint.id}/attempts/${a.id}/redeliver`, { method: 'POST' }),
    onSuccess: (a) => { void queries.invalidateQueries({ queryKey: ['webhook-attempts', clinicId, endpoint.id] }); void queries.invalidateQueries({ queryKey: ['webhooks', clinicId] }); toast({ tone: a.error ? 'error' : 'success', message: `Redelivered: ${outcome(a)}.` }); },
    onError: () => toast({ tone: 'error', message: 'The redelivery did not go out. Try again.' }),
  });
  if (log.isPending) return <Skeleton className="m-5 h-16" />;
  if (!log.data?.attempts.length) return <p className="px-5 py-4 text-sm text-text-muted">Nothing sent yet. Send a test event to try it.</p>;
  return (
    <Table density="compact" aria-label={`Deliveries to ${endpoint.url}`}>
      <THead><tr><TH>When</TH><TH>Event</TH><TH>Result</TH><TH className="hidden md:table-cell">Try</TH><TH><span className="sr-only">Redeliver</span></TH></tr></THead>
      <tbody>
        {log.data.attempts.map((a) => (
          <TRow key={a.id} data-testid="webhook-attempt">
            <TD className="whitespace-nowrap text-sm">{clinicTime(a.at, tz)}</TD>
            <TD className="font-mono text-xs">{a.eventType}{a.kind !== 'automatic' && <Badge className="ml-2">{a.kind === 'test' ? 'Test' : 'Redelivery'}</Badge>}</TD>
            <TD><Badge tone={a.error ? 'danger' : 'ok'}>{outcome(a)}</Badge></TD>
            <TD className="hidden text-sm text-text-muted md:table-cell">{a.attempt}</TD>
            <TD className="text-right"><Button size="sm" variant="ghost" loading={redeliver.isPending && redeliver.variables?.id === a.id} onClick={() => redeliver.mutate(a)}><RotateCcw /> Redeliver</Button></TD>
          </TRow>
        ))}
      </tbody>
    </Table>
  );
}

/**
 * Settings > Integrations: webhooks for n8n, Zapier, Make or the clinic's own systems.
 * Each event says what happened with ids, times and codes, never patient details.
 */
export default function Integrations() {
  const { clinicId } = useParams<{ clinicId: string }>();
  const { clinic, can, isPending } = useClinic(clinicId);
  const queries = useQueryClient();
  const toast = useToast();
  const allowed = can('integrations:manage');
  const list = useQuery({ queryKey: ['webhooks', clinicId], queryFn: () => api<WebhookEndpoints>(`/clinics/${clinicId}/webhooks`), enabled: allowed });
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [events, setEvents] = useState<WebhookEndpoint['events']>(['appointment.booked', 'request.created']);
  const [omitPatientIds, setOmitPatientIds] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [secret, setSecret] = useState<WebhookSecret | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'rotate' | 'delete'; endpoint: WebhookEndpoint } | null>(null);
  const refresh = () => void queries.invalidateQueries({ queryKey: ['webhooks', clinicId] });

  const create = useMutation({
    mutationFn: () => api<WebhookSecret>(`/clinics/${clinicId}/webhooks`, { method: 'POST', body: JSON.stringify({ url: url.trim(), description, events, omitPatientIds }) }),
    onMutate: () => setProblem(null),
    onSuccess: (s) => { setSecret(s); setUrl(''); setDescription(''); refresh(); },
    onError: (e) => setProblem(e instanceof ApiFailure ? e.body.issues?.[0]?.message ?? 'That did not save.' : 'That did not save.'),
  });
  const test = useMutation({
    mutationFn: (e: WebhookEndpoint) => api<WebhookAttempt>(`/clinics/${clinicId}/webhooks/${e.id}/test`, { method: 'POST' }),
    onSuccess: (a, e) => { refresh(); void queries.invalidateQueries({ queryKey: ['webhook-attempts', clinicId, e.id] }); toast({ tone: a.error ? 'error' : 'success', message: a.error ? `The test event failed: ${outcome(a)}.` : `Test event delivered: ${outcome(a)}.` }); },
  });
  const update = useMutation({
    mutationFn: ({ e, patch }: { e: WebhookEndpoint; patch: Partial<Pick<WebhookEndpoint, 'enabled' | 'events' | 'omitPatientIds'>> }) => api<WebhookEndpoint>(`/clinics/${clinicId}/webhooks/${e.id}`, { method: 'PUT', body: JSON.stringify(patch) }),
    onSuccess: refresh,
  });
  const act = useMutation({
    mutationFn: async ({ kind, endpoint }: { kind: 'rotate' | 'delete'; endpoint: WebhookEndpoint }): Promise<WebhookSecret | null> => {
      if (kind === 'rotate') return api<WebhookSecret>(`/clinics/${clinicId}/webhooks/${endpoint.id}/rotate-secret`, { method: 'POST' });
      await api<void>(`/clinics/${clinicId}/webhooks/${endpoint.id}`, { method: 'DELETE' });
      return null;
    },
    onSuccess: (r) => { setConfirm(null); refresh(); if (r) setSecret(r); else toast({ tone: 'success', message: 'Endpoint deleted.' }); },
  });

  const tz = clinic?.timezone ?? 'UTC';
  if (!isPending && !allowed) return <><PageHeader title="Settings" /><SettingsNav clinicId={clinicId} /><Empty title="Not available">Only owners and practice managers manage integrations.</Empty></>;
  const failed = (list.data?.endpoints ?? []).filter((e) => e.disabledReason === 'repeated_failures');

  return (
    <>
      <PageHeader title="Settings" description="Send the clinic's events to n8n, Zapier, Make or your own systems. Events carry ids, times and outcomes, never names or what was said, and no patient ids unless you turn that on for an endpoint." />
      <SettingsNav clinicId={clinicId} />
      {failed.map((e) => (
        <Alert key={e.id} tone="danger" title="An endpoint was turned off" className="mb-6">
          {e.url} failed {e.consecutiveFailures} events in a row, each after a day of retries. Fix the receiver, then turn it back on.
        </Alert>
      ))}
      <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
        <Card className="self-start">
          <CardHeader><CardTitle>Add an endpoint</CardTitle></CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
              <Field label="URL" hint="A public https address. It is checked now, and again at every delivery.">
                <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://n8n.example.com/webhook/attendra" className="font-mono" />
              </Field>
              <Field label="Description"><Input value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} placeholder="n8n: bookings to the practice sheet" /></Field>
              <fieldset className="space-y-2">
                <legend className="mb-2 text-sm font-medium">Events</legend>
                {EVENTS.map((ev) => (
                  <Checkbox key={ev.type} id={`event-${ev.type}`} checked={events.includes(ev.type)} label={<span>{ev.label} <span className="font-mono text-xs text-text-muted">{ev.type}</span></span>}
                    onCheckedChange={(on) => setEvents((xs) => (on ? [...xs, ev.type] : xs.filter((x) => x !== ev.type)))} />
                ))}
              </fieldset>
              <Checkbox id="omit-patient-ids" checked={omitPatientIds} onCheckedChange={setOmitPatientIds}
                label="Leave out patient ids" hint="A patient id with appointment times is patient data. Turn this off only for a receiver covered by a BAA." />
              {problem && <Alert tone="danger">{problem}</Alert>}
              <Button type="submit" loading={create.isPending} disabled={!url.trim() || !events.length}><Plus /> Add endpoint</Button>
            </form>
          </CardContent>
        </Card>
        <div className="space-y-6">
          {list.isPending ? <Skeleton className="h-40" />
            : !list.data?.endpoints.length ? <Card><Empty title="No endpoints yet" icon={<Webhook />}>Add one to send bookings, requests and call outcomes to another system.</Empty></Card>
              : list.data.endpoints.map((e) => (
                <Card key={e.id} data-testid="webhook-endpoint">
                  <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <CardTitle className="break-all font-mono text-base">{e.url}</CardTitle>
                      {e.description && <p className="text-sm text-text-muted">{e.description}</p>}
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        <Badge tone={e.enabled ? 'ok' : 'danger'}>{e.enabled ? 'Active' : e.disabledReason === 'repeated_failures' ? 'Turned off after failures' : 'Turned off'}</Badge>
                        {!e.omitPatientIds && <Badge tone="warn">Sends patient ids</Badge>}
                        {e.rotating && <Badge tone="info"><KeyRound aria-hidden /> Signing with two secrets for a day</Badge>}
                        {e.events.map((x) => <Badge key={x} className="font-mono">{x}</Badge>)}
                      </div>
                    </div>
                    <Switch id={`enabled-${e.id}`} label="On" checked={e.enabled} onCheckedChange={(on) => update.mutate({ e, patch: { enabled: on } })} />
                  </CardHeader>
                  <div className="flex flex-wrap gap-2 border-y border-border px-5 py-3">
                    <Button size="sm" variant="outline" loading={test.isPending && test.variables?.id === e.id} onClick={() => test.mutate(e)}><Send /> Send test event</Button>
                    <Button size="sm" variant="outline" onClick={() => setConfirm({ kind: 'rotate', endpoint: e })}><KeyRound /> Rotate secret</Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirm({ kind: 'delete', endpoint: e })}><Trash2 /> Delete</Button>
                    <Checkbox id={`omit-${e.id}`} checked={e.omitPatientIds} label="Leave out patient ids" onCheckedChange={(on) => update.mutate({ e, patch: { omitPatientIds: on } })} />
                  </div>
                  <DeliveryLog clinicId={clinicId} endpoint={e} tz={tz} />
                </Card>
              ))}
        </div>
      </div>
      <SecretPanel shown={secret} onClose={() => setSecret(null)} />
      <Panel open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm?.kind === 'rotate' ? 'Make a new secret?' : 'Delete this endpoint?'}
        description={confirm?.kind === 'rotate' ? 'Deliveries carry both signatures for 24 hours, so you can switch the receiver over without losing any.' : 'Its delivery log goes with it. This is recorded in the audit log.'}
        footer={<><Button variant="outline" onClick={() => setConfirm(null)}>Cancel</Button>
          <Button variant={confirm?.kind === 'delete' ? 'danger' : 'primary'} loading={act.isPending} onClick={() => confirm && act.mutate(confirm)}>{confirm?.kind === 'rotate' ? 'Make a new secret' : 'Delete'}</Button></>}>
        <p className="break-all font-mono text-sm text-text-muted">{confirm?.endpoint.url}</p>
      </Panel>
    </>
  );
}
