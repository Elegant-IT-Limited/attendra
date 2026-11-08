// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { HandoverPreview, HandoverResult } from '@attendra/api/contracts';
import { type ClinicConfig, localDateOf, providerName } from '@attendra/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/controls';
import { Panel } from '@/components/ui/dialog';
import { Alert, Skeleton } from '@/components/ui/feedback';
import { Label, Select } from '@/components/ui/input';
import { api, ApiFailure } from '@/lib/api';
import { dayTitle, timeOf, visitTypeName } from '@/lib/format';

/**
 * Removing a vet who still has visits to come (note 32): their visits go to other vets at the
 * same day and time. The server decides who can take each one (the booking rules, never a clash),
 * the team sees every move and every visit that cannot move first, and confirms; owners are texted
 * only when the team ticks it. Once nothing is left, the vet can be removed from here.
 */
export function HandoverDialog({ clinicId, clinic, providerId, open, onClose, onRemove, removing }: {
  clinicId: string; clinic: ClinicConfig; providerId: string; open: boolean; onClose: () => void;
  /** Remove the vet, once none of their visits is left. */
  onRemove: () => void; removing: boolean;
}) {
  const queries = useQueryClient();
  const [to, setTo] = useState('');
  const [textOwners, setTextOwners] = useState(false);
  const [result, setResult] = useState<HandoverResult | null>(null);
  const pets = clinic.industry === 'vet';
  const vet = pets ? 'vet' : 'doctor';
  const tz = clinic.timezone;
  const nameOf = (id: string) => { const p = clinic.providers.find((x) => x.id === id); return p ? providerName(p) : id; };
  const leaving = nameOf(providerId);
  const visitName = (id: string) => visitTypeName(clinic.visitTypes.find((v) => v.id === id)?.name ?? id);

  const preview = useQuery({
    queryKey: ['handover', clinicId, providerId, to],
    queryFn: () => api<HandoverPreview>(`/clinics/${clinicId}/doctors/${providerId}/handover/preview`, { method: 'POST', body: JSON.stringify({ toProviderId: to || null }) }),
    enabled: open && !result,
  });
  const moves = (preview.data?.visits ?? []).filter((v) => v.toProviderId);
  const stuck = (preview.data?.visits ?? []).filter((v) => !v.toProviderId);
  const textable = moves.filter((v) => v.textable).length;
  const confirm = useMutation({
    mutationFn: () => api<HandoverResult>(`/clinics/${clinicId}/doctors/${providerId}/handover`, {
      method: 'POST', body: JSON.stringify({ moves: moves.map((v) => ({ appointmentId: v.appointmentId, toProviderId: v.toProviderId })), textOwners }),
    }),
    onSuccess: (r) => {
      setResult(r);
      void queries.invalidateQueries({ queryKey: ['schedule', clinicId] });
      void queries.invalidateQueries({ queryKey: ['slots', clinicId] });
    },
  });
  const close = () => { setResult(null); setTo(''); setTextOwners(false); onClose(); };
  const others = clinic.providers.filter((p) => p.id !== providerId && !p.placeholder);

  const footer = result ? (
    <>
      <Button variant="ghost" onClick={close}>Close</Button>
      {result.remaining === 0 && <Button variant="danger" disabled={removing} onClick={onRemove} data-testid="handover-remove">{removing ? 'Removing…' : `Remove ${leaving}`}</Button>}
    </>
  ) : (
    <>
      <Button variant="ghost" onClick={close} disabled={confirm.isPending}>Cancel</Button>
      <Button disabled={!moves.length || confirm.isPending || preview.isFetching} onClick={() => confirm.mutate()} data-testid="handover-confirm">
        {confirm.isPending ? 'Moving…' : `Move ${moves.length} visit${moves.length === 1 ? '' : 's'}`}
      </Button>
    </>
  );

  return (
    <Panel open={open} onOpenChange={(o) => { if (!o) close(); }} title={`Move ${leaving}'s visits`} side="right" stacked
      description={`Before ${leaving} is removed, each visit still to come goes to another ${vet} at the same day and time. Nothing changes until you confirm.`} footer={footer}>
      {result ? (
        <div className="space-y-4" data-testid="handover-result">
          <Alert tone={result.notMoved.length || result.remaining ? 'warn' : 'ok'} title={`Moved ${result.moved} visit${result.moved === 1 ? '' : 's'}`}>
            {textOwners ? `${result.texts.queued} owner${result.texts.queued === 1 ? '' : 's'} will get a text${result.texts.notTexted ? `; ${result.texts.notTexted} did not agree to texts or have no number, so call them` : ''}.` : 'No owner was texted.'}
          </Alert>
          {result.notMoved.length > 0 && (
            <ul className="space-y-1 text-sm" aria-label="Not moved">
              {result.notMoved.map((n) => <li key={n.appointmentId}><Badge tone="warn">Not moved</Badge> {n.message}</li>)}
            </ul>
          )}
          {result.remaining > 0
            ? <p className="text-sm">{leaving} still has {result.remaining} visit{result.remaining === 1 ? '' : 's'} to come. Move or cancel {result.remaining === 1 ? 'it' : 'them'} on the <Link className="text-primary hover:underline" href={`/c/${clinicId}/schedule?view=agenda&days=7`}>Schedule</Link>, then remove {leaving}.</p>
            : <p className="text-sm">{leaving} has no visits left. You can remove them now.</p>}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="handover-to">Who takes them</Label>
            <Select id="handover-to" value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">{`Whoever is free and does that visit (recommended)`}</option>
              {others.map((p) => {
                const n = preview.data?.candidates.find((c) => c.providerId === p.id)?.canTake;
                return <option key={p.id} value={p.id}>{providerName(p)}{n !== undefined && !to ? `, can take ${n}` : ''}</option>;
              })}
            </Select>
          </div>
          {preview.isPending ? <Skeleton className="h-32" /> : preview.isError ? (
            <Alert tone="danger">{preview.error instanceof ApiFailure && preview.error.body.message ? preview.error.body.message : 'The visits did not load. Try again.'}</Alert>
          ) : (
            <>
              <p className="text-sm" data-testid="handover-summary">
                {preview.data!.visits.length === 0 ? `${leaving} has no visits to come.`
                  : `${moves.length} of ${preview.data!.visits.length} can move.${stuck.length ? ` ${stuck.length} cannot: ${stuck.length === 1 ? 'it stays' : 'they stay'} with ${leaving} until you move or cancel ${stuck.length === 1 ? 'it' : 'them'} on the Schedule.` : ''}`}
              </p>
              <ul className="divide-y divide-border rounded-md border border-border text-sm" aria-label="Visits">
                {preview.data!.visits.map((v) => (
                  <li key={v.appointmentId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2" data-testid="handover-visit">
                    <span className="w-full tabular-nums sm:w-auto">{dayTitle(localDateOf(new Date(v.startsAt), tz))}, {timeOf(v.startsAt, tz)}</span>
                    <span className="text-text-muted">{visitName(v.visitTypeId)}</span>
                    {v.toProviderId
                      ? <span className="ml-auto inline-flex items-center gap-1"><ArrowRight className="size-3.5 text-text-muted" aria-hidden /> {nameOf(v.toProviderId)}</span>
                      : <span className="ml-auto"><Badge tone="warn">Stays</Badge> <span className="text-text-muted">{v.message}</span></span>}
                  </li>
                ))}
              </ul>
              {moves.length > 0 && (
                <Checkbox id="handover-text" checked={textOwners} onCheckedChange={setTextOwners} disabled={!preview.data!.textingOn}
                  label={`Text the owners about the new ${vet}`}
                  hint={preview.data!.textingOn
                    ? `${textable} of ${moves.length} agreed to texts. The text gives the day, the time and the new ${vet}, never why. Call the others.`
                    : 'Texting is off (Settings, Texting), so no owner is texted. Call them instead.'} />
              )}
              {confirm.isError && <Alert tone="danger">{confirm.error instanceof ApiFailure && confirm.error.body.message ? confirm.error.body.message : 'That did not save. Try again.'}</Alert>}
            </>
          )}
        </div>
      )}
    </Panel>
  );
}
