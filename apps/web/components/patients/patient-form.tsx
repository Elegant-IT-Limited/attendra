// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { ageOn, countryCopy, DEFAULT_SPECIES, type Gender, industryPack, localDateOf, managedList } from '@attendra/core';
import type { PatientInput, PatientSaved } from '@attendra/api/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Checkbox } from '@/components/ui/controls';
import { CustomFieldInputs } from '@/components/patients/custom-fields';
import { useProblem } from '@/components/ui/toast';
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
  const [form, setForm] = useState<Omit<PatientInput, 'gender'> & { gender: Gender | '' }>({ firstName: '', lastName: '', dob: '', phone: '', guardianName: '', species: '', ...initial, gender: initial?.gender ?? '' });
  // a vet clinic's records are pets: found on a call by the owner's full name, the pet's name and the phone
  const pet = industryPack(config.data?.industry).identity === 'pet';
  // what did not work, or is worth a look, opens in a dialog in the middle of the screen
  const showProblem = useProblem();
  const setProblem = (p: { text: string; existing?: string }) => showProblem({
    title: p.existing ? 'Already on file' : 'Not saved',
    message: <>{p.text}{p.existing && <>{' '}<Link className="font-medium text-primary underline" href={`/c/${clinicId}/patients/${p.existing}`}>Open their record</Link></>}</>,
  });
  // the clinic's own fields (Settings, Fields and lists), filled in when the record is added; an edit keeps them under Details
  const customFields = !patientId ? config.data?.customFields ?? [] : [];
  const [custom, setCustom] = useState<Record<string, string>>({});
  const today = localDateOf(new Date(), config.data?.timezone ?? 'UTC');
  const child = !!form.dob && form.dob <= today && ageOn(form.dob, today) < 18;
  const save = useMutation({
    mutationFn: async (input: PatientInput) => {
      const r = await api<PatientSaved>(`/clinics/${clinicId}/patients${patientId ? `/${patientId}` : ''}`, {
        method: patientId ? 'PATCH' : 'POST', body: JSON.stringify(input),
      });
      // the record is saved first; its own fields go with it, and a problem with them is said without undoing the record
      let fieldsProblem: string | null = null;
      if (customFields.length && Object.values(custom).some((v) => v.trim())) {
        const values = Object.fromEntries(customFields.map((f) => [f.id, custom[f.id] ?? '']));
        await api<void>(`/clinics/${clinicId}/patients/${r.id}/fields`, { method: 'PUT', body: JSON.stringify({ values }) }).catch((e: unknown) => {
          fieldsProblem = e instanceof ApiFailure && e.body.issues?.length ? e.body.issues.map((i) => `${customFields.find((f) => `values.${f.id}` === i.path)?.label ?? 'A field'}: ${i.message}`).join('. ') : 'check your connection';
        });
      }
      return { ...r, fieldsProblem: fieldsProblem as string | null };
    },
    onSuccess: (r, input) => {
      if (r.fieldsProblem) showProblem({ title: 'Saved, but not its details', message: `The ${pet ? 'pet' : 'patient'} is added. Open the record and fill in the details under Details: ${r.fieldsProblem}.` });
      void queries.invalidateQueries({ queryKey: ['patient', clinicId] });
      void queries.invalidateQueries({ queryKey: ['patient-search', clinicId] });
      void queries.invalidateQueries({ queryKey: ['patients', clinicId] });
      if (r.similar) {
        showProblem({ tone: 'info', title: 'Saved. One thing to check', message: 'Someone else on file has the same name and date of birth, on another phone number. That is allowed; check it is not the same person twice.' });
      }
      onSaved(r.id, input);
    },
    onError: (e) => {
      if (e instanceof ApiFailure && e.status === 409) setProblem({ text: pet ? 'This pet is already on file: the same name, owner, birthday and phone number.' : 'This patient is already on file: the same name, date of birth and phone number.', existing: (e.body as { id?: string }).id });
      else if (e instanceof ApiFailure && e.body.issues?.length) setProblem({ text: e.body.issues.map((i) => i.message).join('. ') });
      else setProblem({ text: 'That did not save. Check your connection and try again.' });
    },
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!form.gender) { setProblem({ text: pet ? 'Choose its sex, or Unknown.' : 'Choose their gender, or Prefers not to say.' }); return; }
    if (pet) {
      const owner = (form.guardianName ?? '').trim().replace(/\s+/g, ' ');
      if (owner.split(' ').length < 2) { setProblem({ text: 'Add the owner\'s first and last name.' }); return; }
      // stored as the assistant stores a pet: its own name, the owner's last name, the owner as the guardian
      save.mutate({ firstName: form.firstName.trim(), lastName: owner.split(' ').at(-1)!, dob: form.dob, gender: form.gender, phone: form.phone.trim(), guardianName: owner, species: form.species?.trim().toLowerCase() || null, textsOk: form.textsOk });
      return;
    }
    save.mutate({ ...form, species: undefined, gender: form.gender, firstName: form.firstName.trim(), lastName: form.lastName.trim(), phone: form.phone.trim(), guardianName: child ? form.guardianName?.trim() || null : null });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {pet ? (
        <fieldset disabled={save.isPending} className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="pet-name">Pet&apos;s name</Label>
            <Input id="pet-name" required maxLength={80} autoComplete="off" value={form.firstName} onChange={set('firstName')} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="species">Kind of animal</Label>
            {/* the clinic's own list, in its order (Settings, Fields and lists); stored in lower case */}
            <Combobox id="species" label="Kind of animal" required maxLength={40} value={form.species ?? ''} onChange={(species) => setForm({ ...form, species })} placeholder="Pick one, or type: dog, cat…"
              options={(config.data ? managedList(config.data, 'species') : [...DEFAULT_SPECIES]).map((k) => ({ value: k.toLowerCase(), label: k }))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dob">Birthday</Label>
            <Input id="dob" type="date" required min="1890-01-01" max={today} value={form.dob} onChange={set('dob')} />
            <p className="text-xs text-text-muted">If the owner only knows the age, pick the same day that many years ago.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="gender">Sex</Label>
            <Select id="gender" required value={form.gender} onChange={set('gender')}>
              <option value="" disabled>Choose</option>
              <option value="female">Female</option><option value="male">Male</option><option value="undisclosed">Unknown</option>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="guardian">Owner&apos;s full name</Label>
            <Input id="guardian" required maxLength={120} autoComplete="off" value={form.guardianName ?? ''} onChange={set('guardianName')} placeholder="First and last name" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="phone">Owner&apos;s phone</Label>
            <Input id="phone" type="tel" required minLength={10} autoComplete="off" value={form.phone} onChange={set('phone')} placeholder={countryCopy({ phoneNumbers: config.data?.phoneNumbers ?? [] }).phone.local} />
            <p className="text-xs text-text-muted">With the area code. The assistant finds the pet by this number, the owner&apos;s name and the pet&apos;s name.</p>
          </div>
        </fieldset>
      ) : (
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
      )}
      {customFields.length > 0 && (
        <fieldset disabled={save.isPending} className="space-y-2">
          <legend className="text-sm font-medium">Your own fields</legend>
          <CustomFieldInputs idPrefix="new-cf" fields={customFields} values={custom} onChange={(id, v) => setCustom((c) => ({ ...c, [id]: v }))} />
        </fieldset>
      )}
      <Checkbox id="texts-ok" label="Texts OK (reminders)" checked={!!form.textsOk} disabled={save.isPending} onCheckedChange={(textsOk) => setForm({ ...form, textsOk })}
        hint="Set when they said yes on a call. Tick it if they agreed in person. Reminder texts go only to people who said yes." />
      <div className="flex justify-end gap-2">
        {onCancel && <Button type="button" variant="ghost" onClick={onCancel} disabled={save.isPending}>Cancel</Button>}
        <Button type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : submitLabel}</Button>
      </div>
    </form>
  );
}
