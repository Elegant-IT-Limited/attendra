// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { ageOn, countryCopy, type Gender, localDateOf } from '@attendra/core';
import type { PatientInput, PatientSaved } from '@attendra/api/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';
import { Input, Label, Select } from '@/components/ui/input';
import { api, ApiFailure, useClinicConfig } from '@/lib/api';

/**
 * A patient's name, date of birth and phone, and a parent or guardian for a child.
 * The assistant verifies callers on exactly the first three together, so they are
 * all required, and asked for the way a caller would give them. A family can share
 * one phone: each child is a patient of their own on the parent's number.
 */
export function PatientForm({ clinicId, patientId, initial, submitLabel, onSaved, onCancel }: {
  clinicId: string;
  /** Set to edit this patient; left out to add a new one. */
  patientId?: string;
  initial?: Partial<Omit<PatientInput, 'gender'>> & { gender?: Gender | null };
  submitLabel: string;
  onSaved: (id: string, input: PatientInput) => void;
  onCancel?: () => void;
}) {
  const queries = useQueryClient();
  const config = useClinicConfig(clinicId);
  const [form, setForm] = useState<Omit<PatientInput, 'gender'> & { gender: Gender | '' }>({ firstName: '', lastName: '', dob: '', phone: '', guardianName: '', ...initial, gender: initial?.gender ?? '' });
  const [problem, setProblem] = useState<{ text: string; existing?: string } | null>(null);
  const [similar, setSimilar] = useState(false);
  const today = localDateOf(new Date(), config.data?.timezone ?? 'UTC');
  const child = !!form.dob && form.dob <= today && ageOn(form.dob, today) < 18;
  const save = useMutation({
    mutationFn: (input: PatientInput) => api<PatientSaved>(`/clinics/${clinicId}/patients${patientId ? `/${patientId}` : ''}`, {
      method: patientId ? 'PATCH' : 'POST', body: JSON.stringify(input),
    }),
    onMutate: () => { setProblem(null); setSimilar(false); },
    onSuccess: (r, input) => {
      void queries.invalidateQueries({ queryKey: ['patient', clinicId] });
      void queries.invalidateQueries({ queryKey: ['patient-search', clinicId] });
      void queries.invalidateQueries({ queryKey: ['patients', clinicId] });
      if (r.similar) setSimilar(true);
      onSaved(r.id, input);
    },
    onError: (e) => {
      if (e instanceof ApiFailure && e.status === 409) setProblem({ text: 'This patient is already on file: the same name, date of birth and phone number.', existing: (e.body as { id?: string }).id });
      else if (e instanceof ApiFailure && e.body.issues?.length) setProblem({ text: e.body.issues.map((i) => i.message).join('. ') });
      else setProblem({ text: 'That did not save. Check your connection and try again.' });
    },
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!form.gender) { setProblem({ text: 'Choose their gender, or Prefers not to say.' }); return; }
    save.mutate({ ...form, gender: form.gender, firstName: form.firstName.trim(), lastName: form.lastName.trim(), phone: form.phone.trim(), guardianName: child ? form.guardianName?.trim() || null : null });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {similar && <Alert>Saved. Someone else on file has the same name and date of birth, on another phone number. That is allowed; check it is not the same person twice.</Alert>}
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
          <Input id="dob" type="date" required min="1890-01-01" max={today} value={form.dob} onChange={set('dob')} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="gender">Gender</Label>
          <Select id="gender" required value={form.gender} onChange={set('gender')}>
            <option value="" disabled>Choose</option>
            <option value="female">Female</option><option value="male">Male</option><option value="other">Other</option><option value="undisclosed">Prefers not to say</option>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="phone">Phone</Label>
          <Input id="phone" type="tel" required minLength={10} autoComplete="off" value={form.phone} onChange={set('phone')} placeholder={countryCopy({ phoneNumbers: config.data?.phoneNumbers ?? [] }).phone.local} />
          <p className="text-xs text-text-muted">With the area code. The assistant uses it, with the name and date of birth, to know who is calling. For a child, the parent&apos;s number.</p>
        </div>
        {child && (
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="guardian">Parent or guardian</Label>
            <Input id="guardian" required maxLength={120} autoComplete="off" value={form.guardianName ?? ''} onChange={set('guardianName')} placeholder="Full name" />
            <p className="text-xs text-text-muted">Under 18: the person who books for them and answers that phone.</p>
          </div>
        )}
      </fieldset>
      <div className="flex justify-end gap-2">
        {onCancel && <Button type="button" variant="ghost" onClick={onCancel} disabled={save.isPending}>Cancel</Button>}
        <Button type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : submitLabel}</Button>
      </div>
    </form>
  );
}
