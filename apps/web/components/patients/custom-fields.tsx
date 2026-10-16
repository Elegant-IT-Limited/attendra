// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { CustomField } from '@attendra/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/controls';
import { Alert } from '@/components/ui/feedback';
import { Input, Label, Select } from '@/components/ui/input';
import { api, ApiFailure } from '@/lib/api';

const shown = (f: CustomField, v: string | undefined) => (!v ? 'Not filled in' : f.kind === 'yesno' ? (v === 'yes' ? 'Yes' : 'No') : v);

/** The clinic's own details on a record (Settings, Fields on each record). Staff fill them in; the assistant does not use them. */
export function CustomFieldsForm({ clinicId, patientId, fields, values, canWrite }: {
  clinicId: string; patientId: string; fields: CustomField[]; values: Record<string, string>; canWrite: boolean;
}) {
  const queries = useQueryClient();
  const [form, setForm] = useState<Record<string, string>>(values);
  const [state, setState] = useState<'idle' | 'saved' | string>('idle');
  const save = useMutation({
    mutationFn: (v: Record<string, string>) => api<void>(`/clinics/${clinicId}/patients/${patientId}/fields`, { method: 'PUT', body: JSON.stringify({ values: v }) }),
    onSuccess: () => { setState('saved'); void queries.invalidateQueries({ queryKey: ['patient', clinicId, patientId] }); },
    onError: (e) => setState(e instanceof ApiFailure && e.body.issues?.length ? e.body.issues.map((i) => `${fields.find((f) => `values.${f.id}` === i.path)?.label ?? 'A field'}: ${i.message}`).join('. ') : 'That did not save. Check your connection and try again.'),
  });
  if (!canWrite) {
    return (
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        {fields.map((f) => <div key={f.id}><dt className="text-text-muted">{f.label}</dt><dd>{shown(f, values[f.id])}</dd></div>)}
      </dl>
    );
  }
  const set = (id: string) => (e: { target: { value: string } }) => { setState('idle'); setForm({ ...form, [id]: e.target.value }); };
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(Object.fromEntries(fields.map((f) => [f.id, form[f.id] ?? '']))); };
  return (
    <form onSubmit={submit} className="space-y-4">
      {state === 'saved' && <Alert>Saved.</Alert>}
      {state !== 'idle' && state !== 'saved' && <Alert tone="warn">{state}</Alert>}
      <fieldset disabled={save.isPending} className="grid gap-4 sm:grid-cols-2">
        {fields.map((f) => (
          <div key={f.id} className="space-y-1.5">
            <Label htmlFor={`cf-${f.id}`}>{f.label}</Label>
            {f.kind === 'yesno' ? (
              <Select id={`cf-${f.id}`} value={form[f.id] ?? ''} onChange={set(f.id)}>
                <option value="">Not filled in</option><option value="yes">Yes</option><option value="no">No</option>
              </Select>
            ) : f.kind === 'date' ? (
              <DatePicker id={`cf-${f.id}`} value={form[f.id] ?? ''} onChange={set(f.id)} />
            ) : (
              <Input id={`cf-${f.id}`} maxLength={200} autoComplete="off" value={form[f.id] ?? ''} onChange={set(f.id)} />
            )}
          </div>
        ))}
      </fieldset>
      <Button type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save details'}</Button>
    </form>
  );
}
