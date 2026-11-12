// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { PatientDeleteCounts, PatientMergeCounts } from '@attendra/api/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitMerge, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PatientPicker } from '@/components/patients/patient-picker';
import type { PatientChoice } from '@/components/schedule/booking-dialog';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/dialog';
import { Alert, Skeleton } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';
import { api, ApiFailure } from '@/lib/api';
import { cn } from '@/lib/utils';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const failure = (e: unknown) => (e instanceof ApiFailure && e.body.message ? e.body.message : 'That did not go through. Try again.');

/**
 * Merging and deleting a record (DATA-5), for owners and practice managers: each opens a confirm step that says,
 * in counts from the server, what will move or go, before anything changes.
 */
export function RecordTools({ clinicId, patient, pet, householdSize }: {
  clinicId: string; patient: { id: string; name: string; phone: string | null }; pet: boolean; householdSize: number;
}) {
  const [open, setOpen] = useState<'merge' | 'delete' | null>(null);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen('merge')} data-testid="merge-open"><GitMerge /> Merge</Button>
      <Button variant="outline" onClick={() => setOpen('delete')} data-testid="delete-open"><Trash2 /> Delete</Button>
      {open === 'merge' && <MergeDialog clinicId={clinicId} patient={patient} pet={pet} onClose={() => setOpen(null)} />}
      {open === 'delete' && <DeleteDialog clinicId={clinicId} patient={patient} pet={pet} householdSize={householdSize} onClose={() => setOpen(null)} />}
    </>
  );
}

function Choice<T extends string>({ name, value, onChange, options }: { name: string; value: T; onChange: (v: T) => void; options: { value: T; label: string; hint: string }[] }) {
  return (
    <fieldset className="space-y-2">
      <legend className="sr-only">{name}</legend>
      {options.map((o) => (
        <label key={o.value} className={cn('flex cursor-pointer gap-3 rounded-md border px-3 py-2 text-sm', value === o.value ? 'border-primary bg-primary-soft/40' : 'border-border')}>
          <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} className="mt-1" />
          <span><span className="font-medium">{o.label}</span><span className="block text-text-muted">{o.hint}</span></span>
        </label>
      ))}
    </fieldset>
  );
}

function DeleteDialog({ clinicId, patient, pet, householdSize, onClose }: { clinicId: string; patient: { id: string; name: string }; pet: boolean; householdSize: number; onClose: () => void }) {
  const [scope, setScope] = useState<'pet' | 'household'>('pet');
  const router = useRouter();
  const toast = useToast();
  const queries = useQueryClient();
  const word = pet ? 'pet' : 'patient';
  const preview = useQuery({
    queryKey: ['patient-delete', clinicId, patient.id, scope],
    queryFn: () => api<PatientDeleteCounts>(`/clinics/${clinicId}/patients/${patient.id}/delete/preview`, { method: 'POST', body: JSON.stringify({ scope }) }),
  });
  const remove = useMutation({
    mutationFn: () => api<PatientDeleteCounts>(`/clinics/${clinicId}/patients/${patient.id}/delete`, { method: 'POST', body: JSON.stringify({ scope }) }),
    onSuccess: (r) => {
      toast({ tone: 'success', message: `Deleted ${plural(r.records, 'record')}.` });
      void queries.invalidateQueries({ queryKey: ['patients', clinicId] });
      void queries.invalidateQueries({ queryKey: ['patient', clinicId] });
      void queries.invalidateQueries({ queryKey: ['schedule', clinicId] });
      router.push(`/c/${clinicId}/patients`);
    },
  });
  const c = preview.data;
  return (
    <Panel open onOpenChange={(o) => { if (!o) onClose(); }} side="right" title={`Delete ${patient.name}`}
      description="Removes the name, number, date of birth and every detail on file. It cannot be undone."
      footer={<><Button variant="ghost" onClick={onClose} disabled={remove.isPending}>Keep it</Button>
        <Button variant="danger" disabled={!c || remove.isPending} onClick={() => remove.mutate()} data-testid="delete-confirm">{remove.isPending ? 'Deleting…' : scope === 'household' ? 'Delete the household' : `Delete this ${word}`}</Button></>}>
      <div className="space-y-4">
        {householdSize > 1 && (
          <Choice name="delete-scope" value={scope} onChange={setScope} options={[
            { value: 'pet', label: `Only ${patient.name}`, hint: `The others on this number stay.` },
            { value: 'household', label: `Everyone on this number (${householdSize})`, hint: pet ? 'The owner and every pet on the number.' : 'Everyone on the number.' },
          ]} />
        )}
        {preview.isPending ? <Skeleton className="h-24" /> : preview.isError ? <Alert tone="danger">{failure(preview.error)}</Alert> : (
          <ul className="list-disc space-y-1 pl-5 text-sm" data-testid="delete-preview">
            <li>{plural(c!.records, 'record')} emptied: name, number, date of birth, kind and the clinic&apos;s own details; no search will find {c!.records === 1 ? 'it' : 'them'} again.</li>
            <li>{plural(c!.upcomingCancelled, 'visit')} still to come cancelled.</li>
            <li>{plural(c!.visitsKept, 'past visit')} kept with no name, so the clinic&apos;s counts stay right.</li>
            <li>{plural(c!.requests, 'request')}: details and notes removed.</li>
            <li>{plural(c!.callsUnlinked, 'call')} no longer linked; call records follow the clinic&apos;s retention period.</li>
          </ul>
        )}
        {remove.isError && <Alert tone="danger">{failure(remove.error)}</Alert>}
      </div>
    </Panel>
  );
}

function MergeDialog({ clinicId, patient, pet, onClose }: { clinicId: string; patient: { id: string; name: string; phone: string | null }; pet: boolean; onClose: () => void }) {
  const [kind, setKind] = useState<'pet' | 'household'>('pet');
  const [other, setOther] = useState<PatientChoice | null>(null);
  const toast = useToast();
  const queries = useQueryClient();
  const body = other ? { kind, keepId: patient.id, mergeId: other.id } : null;
  const preview = useQuery({
    queryKey: ['patient-merge', clinicId, body],
    queryFn: () => api<PatientMergeCounts>(`/clinics/${clinicId}/patients/merge/preview`, { method: 'POST', body: JSON.stringify(body) }),
    enabled: !!body, retry: false,
  });
  const merge = useMutation({
    mutationFn: () => api<PatientMergeCounts>(`/clinics/${clinicId}/patients/merge`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      toast({ tone: 'success', message: 'Merged.' });
      void queries.invalidateQueries({ queryKey: ['patients', clinicId] });
      void queries.invalidateQueries({ queryKey: ['patient', clinicId] });
      void queries.invalidateQueries({ queryKey: ['schedule', clinicId] });
      onClose();
    },
  });
  const c = preview.data;
  return (
    <Panel open onOpenChange={(o) => { if (!o) onClose(); }} side="right" title={`Merge into ${patient.name}`}
      description={`${patient.name} is kept. The other record's visits, calls, requests and texts move here, and the other record goes.`}
      footer={<><Button variant="ghost" onClick={onClose} disabled={merge.isPending}>Cancel</Button>
        <Button disabled={!c || merge.isPending} onClick={() => merge.mutate()} data-testid="merge-confirm">{merge.isPending ? 'Merging…' : 'Merge'}</Button></>}>
      <div className="space-y-4">
        <Choice name="merge-kind" value={kind} onChange={setKind} options={[
          { value: 'pet', label: pet ? 'The same pet twice' : 'The same person twice', hint: 'Two records of one animal: everything moves to this one.' },
          { value: 'household', label: pet ? 'The same owner on two numbers' : 'The same family on two numbers', hint: `Every ${pet ? 'pet' : 'record'} on the other number moves to ${patient.phone ? 'this number' : 'this record\'s number'} and owner; one ${pet ? 'pet' : 'person'} on both becomes one record.` },
        ]} />
        {other ? (
          <div className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
            <span>Merging away: <span className="font-medium">{other.name}</span></span>
            <Button size="sm" variant="ghost" onClick={() => setOther(null)}>Change</Button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm font-medium">The other record</p>
            <PatientPicker clinicId={clinicId} onPick={setOther} canAdd={false} exclude={patient.id} />
          </div>
        )}
        {body && (preview.isPending ? <Skeleton className="h-20" /> : preview.isError ? <Alert tone="warn">{failure(preview.error)}</Alert> : (
          <ul className="list-disc space-y-1 pl-5 text-sm" data-testid="merge-preview">
            <li>{plural(c!.records, 'record')} merged away{c!.duplicates ? `, ${plural(c!.duplicates, 'of them', 'of them')} the same ${pet ? 'pet' : 'person'} on both numbers` : ''}.</li>
            <li>{plural(c!.appointments, 'visit')}, {plural(c!.calls, 'call')}, {plural(c!.requests, 'request')} and {plural(c!.texts, 'text')} move to {patient.name}{kind === 'household' ? '\'s household' : ''}.</li>
          </ul>
        ))}
        {merge.isError && <Alert tone="danger">{failure(merge.error)}</Alert>}
      </div>
    </Panel>
  );
}
