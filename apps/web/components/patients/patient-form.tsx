// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { countryCopy, localDateOf } from '@attendra/core';
import type { PatientInput, PatientSaved } from '@attendra/api/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';
import { Input, Label } from '@/components/ui/input';
import { api, ApiFailure, useClinicConfig } from '@/lib/api';

/**
 * A patient's name, date of birth and phone. The assistant verifies callers on
 * exactly these, so they are asked for the way a caller would give them.
 */
export function PatientForm({ clinicId, patientId, initial, submitLabel, onSaved, onCancel }: {
  clinicId: string;
  /** Set to edit this patient; left out to add a new one. */
  patientId?: string;
  initial?: Partial<PatientInput>;
  submitLabel: string;
  onSaved: (id: string, input: PatientInput) => void;
  onCancel?: () => void;
}) {
  const queries = useQueryClient();
  const config = useClinicConfig(clinicId);
  const [form, setForm] = useState<PatientInput>({ firstName: '', lastName: '', dob: '', phone: '', ...initial });
  const [problem, setProblem] = useState<{ text: string; existing?: string } | null>(null);
  const save = useMutation({
    mutationFn: (input: PatientInput) => api<PatientSaved>(`/clinics/${clinicId}/patients${patientId ? `/${patientId}` : ''}`, {
      method: patientId ? 'PATCH' : 'POST', body: JSON.stringify(input),
    }),
    onMutate: () => setProblem(null),
    onSuccess: (r, input) => {
      void queries.invalidateQueries({ queryKey: ['patient', clinicId] });
      void queries.invalidateQueries({ queryKey: ['patient-search', clinicId] });
      onSaved(r.id, input);
    },
    onError: (e) => {
      if (e instanceof ApiFailure && e.status === 409) setProblem({ text: 'Someone with this name and date of birth is already on file.', existing: (e.body as { id?: string }).id });
      else if (e instanceof ApiFailure && e.body.issues?.length) setProblem({ text: e.body.issues.map((i) => i.message).join('. ') });
      else setProblem({ text: 'That did not save. Check your connection and try again.' });
    },
  });
  const set = (k: keyof PatientInput) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate({ ...form, firstName: form.firstName.trim(), lastName: form.lastName.trim(), phone: form.phone?.trim() }); };

  return (
    <form onSubmit={submit} className="space-y-4">
      {problem && (
        <Alert tone="warn">
          {problem.text}{' '}
          {problem.existing && <Link className="font-medium underline" href={`/c/${clinicId}/patients/${problem.existing}`}>Open their record</Link>}
        </Alert>
      )}
      <fieldset disabled={save.isPending} className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="first-name">First name</Label>
          <Input id="first-name" required maxLength={80} autoComplete="off" value={form.firstName} onChange={set('firstName')} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="last-name">Last name</Label>
          <Input id="last-name" required maxLength={80} autoComplete="off" value={form.lastName} onChange={set('lastName')} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="dob">Date of birth</Label>
          <Input id="dob" type="date" required min="1890-01-01" max={localDateOf(new Date(), config.data?.timezone ?? 'UTC')} value={form.dob} onChange={set('dob')} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="phone">Phone (optional)</Label>
          <Input id="phone" type="tel" autoComplete="off" value={form.phone ?? ''} onChange={set('phone')} placeholder={countryCopy({ phoneNumbers: config.data?.phoneNumbers ?? [] }).phone.local} />
          <p className="text-xs text-text-muted">Texts about bookings go to this number.</p>
        </div>
      </fieldset>
      <div className="flex justify-end gap-2">
        {onCancel && <Button type="button" variant="ghost" onClick={onCancel} disabled={save.isPending}>Cancel</Button>}
        <Button type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : submitLabel}</Button>
      </div>
    </form>
  );
}
