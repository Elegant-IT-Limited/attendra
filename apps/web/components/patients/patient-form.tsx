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
import { useAddToList } from '@/lib/lists';

/**
 * A patient's name, date of birth and phone, and a parent or guardian for a child.
 * The assistant verifies callers on exactly the first three together, so they are
 * all required, and asked for the way a caller would give them. A family can share
 * one phone: each child is a patient of their own on the parent's number.
 *
 * At a vet clinic it is the one pet form: Pets (Add and Edit) and a new booking's "New
 * pet" step all use it, so they cannot drift apart. The owner's first name is required
 * and the last name is not: many people go by one name. A problem with one field is
 * said under that field; the "Not saved" dialog is only for the rest.
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
  // a pet's owner, in two boxes: the guardian on the record is both, the pet's family name the last
  const [owner, setOwner] = useState(() => ownerParts(initial?.guardianName ?? '', initial?.lastName ?? ''));
  // what is wrong with one field, said under it
  const [errors, setErrors] = useState<Partial<Record<'firstName' | 'lastName' | 'dob' | 'gender' | 'phone' | 'guardianName' | 'species', string>>>({});
  // a vet clinic's records are pets: found on a call by the owner's name, the pet's name and the phone
  const pet = industryPack(config.data?.industry).identity === 'pet';
  // the kind of animal is picked from the clinic's list; owners and managers can add to it from here
  const addSpecies = useAddToList(clinicId, 'species');
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
      else if (e instanceof ApiFailure && e.body.issues?.length) {
        // a field's problem goes under that field; only the rest opens the dialog
        const own = e.body.issues.filter((i) => FIELDS.includes(i.path as (typeof FIELDS)[number]));
        setErrors(Object.fromEntries(own.map((i) => [i.path, sentence(i.message)])));
        const rest = e.body.issues.filter((i) => !own.includes(i));
        if (rest.length) setProblem({ text: rest.map((i) => i.message).join('. ') });
      }
      else setProblem({ text: 'That did not save. Check your connection and try again.' });
    },
  });
  // an edit that leaves the kind of animal as it was does not send it, so a pet keeps one that is not on the list
  const speciesSent = (v: string | null | undefined) => {
    const now = v?.trim().toLowerCase() || null;
    return patientId && now === (initial?.species?.trim().toLowerCase() || null) ? undefined : now;
  };
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => { setForm({ ...form, [k]: e.target.value }); setErrors((x) => ({ ...x, [k]: undefined })); };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    // checked here, so each problem shows under its own field before anything is sent
    const found: typeof errors = {};
    if (!form.gender) found.gender = pet ? 'Choose its sex, or Unknown.' : 'Choose their gender, or Prefers not to say.';
    if (form.dob && form.dob > today) found.dob = pet ? 'A birthday can\'t be in the future.' : 'A date of birth can\'t be in the future.';
    if (pet && !owner.first.trim()) found.guardianName = 'Add the owner\'s first name.';
    setErrors(found);
    if (Object.keys(found).length || !form.gender) return;
    if (pet) {
      const first = owner.first.trim().replace(/\s+/g, ' ');
      const last = owner.last.trim().replace(/\s+/g, ' ');
      // stored as the assistant stores a pet: its own name, the owner's last name (none for an owner with one name), the owner as the guardian
      save.mutate({ firstName: form.firstName.trim(), lastName: last, dob: form.dob, gender: form.gender, phone: form.phone.trim(), guardianName: `${first} ${last}`.trim(), species: speciesSent(form.species), textsOk: form.textsOk });
      return;
    }
    save.mutate({ ...form, species: undefined, gender: form.gender, firstName: form.firstName.trim(), lastName: form.lastName.trim(), phone: form.phone.trim(), guardianName: child ? form.guardianName?.trim() || null : null });
  };
  const err = (k: keyof typeof errors) => (errors[k] ? { 'aria-invalid': true as const, 'aria-describedby': `${k}-error` } : {});
  const problem = (k: keyof typeof errors) => (errors[k] ? <p id={`${k}-error`} className="text-xs font-medium text-danger">{errors[k]}</p> : null);

  return (
    <form onSubmit={submit} className="space-y-4">
      {pet ? (
        <fieldset disabled={save.isPending} className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="pet-name">Pet&apos;s name</Label>
            <Input id="pet-name" required maxLength={80} autoComplete="off" value={form.firstName} onChange={set('firstName')} {...err('firstName')} />
            {problem('firstName')}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="species">Kind of animal</Label>
            {/* the clinic's own list, in its order (Settings, Fields and lists); stored in lower case */}
            <Combobox id="species" label="Kind of animal" required value={form.species ?? ''} onChange={(species) => { setForm({ ...form, species: species.toLowerCase() }); setErrors((x) => ({ ...x, species: undefined })); }} placeholder="Pick from your list"
              options={(config.data ? managedList(config.data, 'species') : [...DEFAULT_SPECIES]).map((k) => ({ value: k.toLowerCase(), label: k }))}
              onAdd={addSpecies} addLabel="Add a kind of animal" error={errors.species} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dob">Birthday</Label>
            {/* no max: a date after today is said under the field, in words, not by the browser */}
            <Input id="dob" type="date" required min="1890-01-01" value={form.dob} onChange={set('dob')} {...err('dob')} />
            {errors.dob ? problem('dob') : <p className="text-xs text-text-muted">If the owner only knows the age, pick the same day that many years ago.</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="gender">Sex</Label>
            <Select id="gender" required value={form.gender} onChange={set('gender')} {...err('gender')}>
              <option value="" disabled>Choose</option>
              <option value="female">Female</option><option value="male">Male</option><option value="undisclosed">Unknown</option>
            </Select>
            {problem('gender')}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="owner-first">Owner&apos;s first name</Label>
            <Input id="owner-first" required maxLength={60} autoComplete="off" value={owner.first} {...err('guardianName')}
              onChange={(e) => { setOwner({ ...owner, first: e.target.value }); setErrors((x) => ({ ...x, guardianName: undefined })); }} />
            {problem('guardianName')}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="owner-last">Owner&apos;s last name <span className="font-normal text-text-muted">(optional)</span></Label>
            <Input id="owner-last" maxLength={60} autoComplete="off" value={owner.last} aria-describedby={errors.lastName ? 'lastName-error' : 'owner-last-hint'} aria-invalid={errors.lastName ? true : undefined}
              onChange={(e) => { setOwner({ ...owner, last: e.target.value }); setErrors((x) => ({ ...x, lastName: undefined })); }} />
            {errors.lastName ? problem('lastName') : <p id="owner-last-hint" className="text-xs text-text-muted">Leave empty if they go by one name.</p>}
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="phone">Owner&apos;s phone</Label>
            <Input id="phone" type="tel" required minLength={10} autoComplete="off" value={form.phone} onChange={set('phone')} placeholder={countryCopy({ phoneNumbers: config.data?.phoneNumbers ?? [] }).phone.local} {...err('phone')} />
            {errors.phone ? problem('phone') : <p className="text-xs text-text-muted">With the area code. The assistant finds the pet by this number, the owner&apos;s name and the pet&apos;s name.</p>}
          </div>
        </fieldset>
      ) : (
      <fieldset disabled={save.isPending} className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="first-name">First name</Label>
          <Input id="first-name" required maxLength={80} autoComplete="off" value={form.firstName} onChange={set('firstName')} {...err('firstName')} />
          {problem('firstName')}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="last-name">Last name</Label>
          <Input id="last-name" required maxLength={80} autoComplete="off" value={form.lastName} onChange={set('lastName')} {...err('lastName')} />
          {problem('lastName')}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="dob">Date of birth</Label>
          <Input id="dob" type="date" required min="1890-01-01" value={form.dob} onChange={set('dob')} {...err('dob')} />
          {problem('dob')}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="gender">Gender</Label>
          <Select id="gender" required value={form.gender} onChange={set('gender')} {...err('gender')}>
            <option value="" disabled>Choose</option>
            <option value="female">Female</option><option value="male">Male</option><option value="other">Other</option><option value="undisclosed">Prefers not to say</option>
          </Select>
          {problem('gender')}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="phone">Phone</Label>
          <Input id="phone" type="tel" required minLength={10} autoComplete="off" value={form.phone} onChange={set('phone')} placeholder={countryCopy({ phoneNumbers: config.data?.phoneNumbers ?? [] }).phone.local} {...err('phone')} />
          {errors.phone ? problem('phone') : <p className="text-xs text-text-muted">With the area code. The assistant uses it, with the name and date of birth, to know who is calling. For a child, the parent&apos;s number.</p>}
        </div>
        {child && (
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="guardian">Parent or guardian</Label>
            <Input id="guardian" required maxLength={120} autoComplete="off" value={form.guardianName ?? ''} onChange={set('guardianName')} placeholder="Full name" {...err('guardianName')} />
            {errors.guardianName ? problem('guardianName') : <p className="text-xs text-text-muted">Under 18: the person who books for them and answers that phone.</p>}
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

/** The fields a save's problem can be about, by the API's path: each is said under its field. */
const FIELDS = ['firstName', 'lastName', 'dob', 'gender', 'phone', 'guardianName', 'species'] as const;
/** The API's lower-case messages read as a sentence under a field. */
const sentence = (m: string) => { const t = m.charAt(0).toUpperCase() + m.slice(1); return /[.!?]$/.test(t) ? t : `${t}.`; };

/**
 * A pet's owner on file, back in two boxes: the guardian name ends with the pet's family name
 * when there is one ("Jordan Rivera", "Rivera"), and is all first name when there is not.
 */
export function ownerParts(guardian: string, lastName: string): { first: string; last: string } {
  const full = guardian.trim().replace(/\s+/g, ' ');
  const last = lastName.trim();
  if (last && full.toLowerCase().endsWith(` ${last.toLowerCase()}`)) return { first: full.slice(0, full.length - last.length - 1), last: full.slice(full.length - last.length) };
  return { first: full, last: '' };
}
