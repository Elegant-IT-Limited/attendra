// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { type CustomField, MULTI_SEPARATOR, multiValues } from '@attendra/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox, DatePicker } from '@/components/ui/controls';
import { Alert } from '@/components/ui/feedback';
import { Input, Label, Select } from '@/components/ui/input';
import { api, ApiFailure } from '@/lib/api';

/** A value as staff read it: "Yes", "Cat, Rabbit", or "Not filled in". */
export const shownValue = (f: CustomField, v: string | undefined) =>
  (!v ? 'Not filled in' : f.kind === 'yesno' ? (v === 'yes' ? 'Yes' : 'No') : f.kind === 'multi' ? multiValues(v).join(', ') : v);

/**
 * The clinic's own details on a record (Settings, Fields and lists): a pet or patient,
 * or a request. Staff fill them in; the assistant does not use them. A field marked
 * "must be filled in" has to be before the details save.
 */
export function CustomFieldsForm({ clinicId, patientId, saveUrl, queryKey, fields, values, canWrite, compact }: {
  clinicId: string; patientId?: string; fields: CustomField[]; values: Record<string, string>; canWrite: boolean;
  /** Where the whole set is saved, when it is not a patient's: a request's. */
  saveUrl?: string; queryKey?: unknown[]; compact?: boolean;
}) {
  const queries = useQueryClient();
  const [form, setForm] = useState<Record<string, string>>(values);
  const [state, setState] = useState<'idle' | 'saved' | string>('idle');
  const url = saveUrl ?? `/clinics/${clinicId}/patients/${patientId}/fields`;
  const save = useMutation({
    mutationFn: (v: Record<string, string>) => api<void>(url, { method: 'PUT', body: JSON.stringify({ values: v }) }),
    onSuccess: () => { setState('saved'); void queries.invalidateQueries({ queryKey: queryKey ?? ['patient', clinicId, patientId] }); },
    onError: (e) => setState(e instanceof ApiFailure && e.body.issues?.length ? e.body.issues.map((i) => `${fields.find((f) => `values.${f.id}` === i.path)?.label ?? 'A field'}: ${i.message}`).join('. ') : 'That did not save. Check your connection and try again.'),
  });
  if (!canWrite) {
    return (
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        {fields.map((f) => <div key={f.id}><dt className="text-text-muted">{f.label}</dt><dd>{shownValue(f, values[f.id])}</dd></div>)}
      </dl>
    );
  }
  const put = (id: string, v: string) => { setState('idle'); setForm({ ...form, [id]: v }); };
  const missing = fields.filter((f) => f.required && !form[f.id]?.trim());
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (missing.length) { setState(`Fill in ${missing.map((f) => f.label).join(', ')} first.`); return; }
    save.mutate(Object.fromEntries(fields.map((f) => [f.id, form[f.id] ?? ''])));
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      {state === 'saved' && <Alert>Saved.</Alert>}
      {state !== 'idle' && state !== 'saved' && <Alert tone="warn">{state}</Alert>}
      <fieldset disabled={save.isPending}>
        <CustomFieldInputs fields={fields} values={form} onChange={put} compact={compact} />
      </fieldset>
      <Button type="submit" size={compact ? 'sm' : undefined} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save details'}</Button>
    </form>
  );
}

/** The inputs for the clinic's own fields, controlled: in a form of their own, or inside another (a doctor's). */
export function CustomFieldInputs({ fields, values, onChange, compact, idPrefix = 'cf' }: {
  fields: CustomField[]; values: Record<string, string>; onChange: (id: string, value: string) => void; compact?: boolean; idPrefix?: string;
}) {
  const set = (id: string) => (e: { target: { value: string } }) => onChange(id, e.target.value);
  return (
    <div className={compact ? 'grid gap-3' : 'grid gap-4 sm:grid-cols-2'}>
      {fields.map((f) => {
        const id = `${idPrefix}-${f.id}`;
        return (
          <div key={f.id} className="space-y-1.5">
            <Label htmlFor={id}>{f.label}{f.required && <span className="text-danger" aria-label="required"> *</span>}</Label>
            {f.kind === 'yesno' ? (
              <Select id={id} value={values[f.id] ?? ''} onChange={set(f.id)}>
                <option value="">Not filled in</option><option value="yes">Yes</option><option value="no">No</option>
              </Select>
            ) : f.kind === 'date' ? (
              <DatePicker id={id} value={values[f.id] ?? ''} onChange={set(f.id)} />
            ) : f.kind === 'choice' ? (
              <Select id={id} value={values[f.id] ?? ''} onChange={set(f.id)}>
                <option value="">Not filled in</option>
                {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </Select>
            ) : f.kind === 'multi' ? (
              <div id={id} role="group" aria-label={f.label} className="flex flex-wrap gap-x-4 gap-y-2">
                {(f.options ?? []).map((o) => {
                  const picked = multiValues(values[f.id]);
                  return (
                    <Checkbox key={o} id={`${id}-${o}`} label={o} checked={picked.includes(o)}
                      onCheckedChange={(on) => onChange(f.id, (f.options ?? []).filter((x) => (x === o ? on : picked.includes(x))).join(MULTI_SEPARATOR))} />
                  );
                })}
              </div>
            ) : (
              <Input id={id} maxLength={200} autoComplete="off" inputMode={f.kind === 'number' ? 'decimal' : undefined} value={values[f.id] ?? ''} onChange={set(f.id)} />
            )}
          </div>
        );
      })}
    </div>
  );
}
