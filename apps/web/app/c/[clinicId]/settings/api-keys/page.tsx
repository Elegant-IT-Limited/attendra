// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { ApiKeyCreated, ApiKeys, ApiKeyView } from '@attendra/api/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Plus } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Field } from '@/components/settings/section';
import { SettingsNav } from '@/components/settings/settings-nav';
import { PageHeader } from '@/components/shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/controls';
import { Panel } from '@/components/ui/dialog';
import { Alert, Empty, Skeleton } from '@/components/ui/feedback';
import { Input, Select } from '@/components/ui/input';
import { Table, TD, TH, THead, TRow } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, ApiFailure, useClinic } from '@/lib/api';
import { clinicTime } from '@/lib/format';

const SCOPES: { scope: ApiKeyView['scopes'][number]; label: string; hint: string }[] = [
  { scope: 'schedule:read', label: 'Read the schedule', hint: 'Open times, and today\'s appointments with patient names.' },
  { scope: 'requests:read', label: 'Read requests', hint: 'The open refill and callback requests, with their details.' },
  { scope: 'requests:write', label: 'Close requests', hint: 'Mark a request done, with its outcome.' },
];
const STATUS: Record<ApiKeyView['status'], { label: string; tone: 'ok' | 'neutral' | 'danger' }> = { active: { label: 'Active', tone: 'ok' }, expired: { label: 'Expired', tone: 'neutral' }, revoked: { label: 'Revoked', tone: 'danger' } };

/**
 * Settings > API keys: keys for another AI agent, such as Claude Desktop, to work with
 * the front desk over MCP. It can find open times, read the schedule and requests,
 * close requests and read quality numbers. It can never book or cancel.
 */
export default function ApiKeysPage() {
  const { clinicId } = useParams<{ clinicId: string }>();
  const { clinic, can, isPending } = useClinic(clinicId);
  const queries = useQueryClient();
  const toast = useToast();
  const allowed = can('integrations:manage');
  const list = useQuery({ queryKey: ['api-keys', clinicId], queryFn: () => api<ApiKeys>(`/clinics/${clinicId}/api-keys`), enabled: allowed });
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiKeyView['scopes']>(['schedule:read']);
  const [days, setDays] = useState('90');
  const [shown, setShown] = useState<ApiKeyCreated | null>(null);
  const [revoking, setRevoking] = useState<ApiKeyView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const refresh = () => void queries.invalidateQueries({ queryKey: ['api-keys', clinicId] });

  const create = useMutation({
    mutationFn: () => api<ApiKeyCreated>(`/clinics/${clinicId}/api-keys`, { method: 'POST', body: JSON.stringify({ name: name.trim(), scopes, expiresInDays: Number(days) }) }),
    onMutate: () => setProblem(null),
    onSuccess: (k) => { setShown(k); setName(''); refresh(); },
    onError: (e) => setProblem(e instanceof ApiFailure ? e.body.issues?.[0]?.message ?? 'That did not save.' : 'That did not save.'),
  });
  const revoke = useMutation({
    mutationFn: (k: ApiKeyView) => api<void>(`/clinics/${clinicId}/api-keys/${k.id}`, { method: 'DELETE' }),
    onSuccess: () => { setRevoking(null); refresh(); toast({ tone: 'success', message: 'Revoked. The key stopped working.' }); },
  });
  const tz = clinic?.timezone ?? 'UTC';

  if (!isPending && !allowed) return <><PageHeader title="Settings" /><SettingsNav clinicId={clinicId} /><Empty title="Not available">Only owners and practice managers manage API keys.</Empty></>;
  return (
    <>
      <PageHeader title="Settings" description="Keys for another AI agent to work with the front desk over MCP. It can read and close requests, but it can never book or cancel. docs/mcp.md shows how to connect one." />
      <SettingsNav clinicId={clinicId} />
      <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
        <Card className="self-start">
          <CardHeader><CardTitle>Make a key</CardTitle></CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
              <Field label="Name" hint="Who or what will use it, like Claude Desktop at the front desk."><Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></Field>
              <fieldset className="space-y-2">
                <legend className="mb-2 text-sm font-medium">What it may do</legend>
                {SCOPES.map((s) => (
                  <Checkbox key={s.scope} id={`scope-${s.scope}`} checked={scopes.includes(s.scope)} label={s.label} hint={s.hint}
                    onCheckedChange={(on) => setScopes((xs) => (on ? [...xs, s.scope] : xs.filter((x) => x !== s.scope)))} />
                ))}
              </fieldset>
              <Field label="Expires after">
                <Select value={days} onChange={(e) => setDays(e.target.value)}>
                  <option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option><option value="365">A year</option>
                </Select>
              </Field>
              {problem && <Alert tone="danger">{problem}</Alert>}
              <Button type="submit" loading={create.isPending} disabled={!name.trim() || !scopes.length}><Plus /> Make key</Button>
            </form>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Keys</CardTitle></CardHeader>
          {list.isPending ? <Skeleton className="m-5 h-24" /> : !list.data?.keys.length ? <Empty title="No keys yet" icon={<KeyRound />}>A key lets another AI agent read the schedule and requests.</Empty> : (
            <Table>
              <THead><tr><TH>Name</TH><TH>Scopes</TH><TH>Status</TH><TH className="hidden md:table-cell">Last used</TH><TH><span className="sr-only">Revoke</span></TH></tr></THead>
              <tbody>
                {list.data.keys.map((k) => (
                  <TRow key={k.id} data-testid="api-key">
                    <TD><p className="font-medium">{k.name}</p><p className="font-mono text-xs text-text-muted">{k.prefix}…</p></TD>
                    <TD><span className="flex flex-wrap gap-1">{k.scopes.map((s) => <Badge key={s} className="font-mono">{s}</Badge>)}</span></TD>
                    <TD><Badge tone={STATUS[k.status].tone}>{STATUS[k.status].label}</Badge><p className="mt-1 text-xs text-text-muted">{k.status === 'active' ? `until ${clinicTime(k.expiresAt, tz)}` : ''}</p></TD>
                    <TD className="hidden text-sm text-text-muted md:table-cell">{k.lastUsedAt ? clinicTime(k.lastUsedAt, tz) : 'Never'}</TD>
                    <TD className="text-right">{k.status === 'active' && <Button size="sm" variant="ghost" onClick={() => setRevoking(k)}>Revoke</Button>}</TD>
                  </TRow>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
      <Panel open={!!shown} onOpenChange={(o) => !o && setShown(null)} title="Copy the key" description="This is the only time it is shown. Attendra keeps only a hash of it." footer={<Button onClick={() => setShown(null)}>Done</Button>}>
        <div className="space-y-3">
          <code className="block break-all rounded-md border border-border bg-surface-sunken px-3 py-2 font-mono text-sm" data-testid="api-key-value">{shown?.key}</code>
          <Button variant="outline" size="sm" onClick={() => { void navigator.clipboard?.writeText(shown?.key ?? '').then(() => toast({ tone: 'success', message: 'Copied.' }), () => {}); }}><Copy /> Copy</Button>
          <p className="text-sm text-text-muted">Every use is recorded in the audit log with this key.</p>
        </div>
      </Panel>
      <Panel open={!!revoking} onOpenChange={(o) => !o && setRevoking(null)} title={`Revoke ${revoking?.name ?? 'this key'}?`} description="It stops working at once, for whatever is using it."
        footer={<><Button variant="outline" onClick={() => setRevoking(null)}>Cancel</Button><Button variant="danger" loading={revoke.isPending} onClick={() => revoking && revoke.mutate(revoking)}>Revoke</Button></>}>
        <p className="font-mono text-sm text-text-muted">{revoking?.prefix}…</p>
      </Panel>
    </>
  );
}
