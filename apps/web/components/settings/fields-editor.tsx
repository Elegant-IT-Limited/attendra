// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { CUSTOM_FIELD_KINDS, type CustomField } from '@attendra/core';
import { ArrowDown, ArrowUp, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { EmptyNote, Field, Item, Section } from '@/components/settings/section';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/controls';
import { Input, Select, Textarea } from '@/components/ui/input';

export const KIND_LABELS: Record<CustomField['kind'], string> = {
  text: 'Text', number: 'Number', yesno: 'Yes or no', date: 'Date', choice: 'Dropdown (pick one)', multi: 'Dropdown (pick several)',
};
const dropdown = (k: CustomField['kind']) => k === 'choice' || k === 'multi';
const newFieldId = () => `field_${Math.random().toString(36).slice(2, 8)}`;

/**
 * The clinic's own fields on one kind of record: a label, a kind (dropdowns with their
 * choices), whether it must be filled in, and whether it shows as a column. A new field
 * goes to the top with the cursor in it; with an empty one already there, the button
 * goes to that one instead. Dropdowns and yes-or-no fields become filters on the list.
 */
export function FieldsEditor({ id, title, description, fields, onChange, disabled, placeholder }: {
  id: string; title: string; description: string; fields: CustomField[]; onChange: (fields: CustomField[]) => void; disabled: boolean; placeholder: string;
}) {
  const [focus, setFocus] = useState<string | null>(null);
  useEffect(() => {
    if (!focus) return;
    const el = document.getElementById(focus);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
    setFocus(null);
  }, [focus, fields]);
  const upd = (i: number, patch: Partial<CustomField>) => onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const move = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= fields.length) return;
    const next = [...fields];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  const add = () => {
    const empty = fields.find((f) => !f.label.trim());
    if (empty) { setFocus(`${id}-${empty.id}`); return; }
    const fresh: CustomField = { id: newFieldId(), label: '', kind: 'text' };
    onChange([fresh, ...fields]);
    setFocus(`${id}-${fresh.id}`);
  };

  return (
    <Section id={id} title={title} description={description}
      action={<Button type="button" size="sm" variant="outline" disabled={disabled || fields.length >= 20} onClick={add}><Plus /> Field</Button>}>
      {!fields.length && <EmptyNote>No fields yet. Add one for anything you keep that has no place yet.</EmptyNote>}
      {fields.map((f, i) => (
        <Item key={f.id} id={`${id}-${f.id}`} removeLabel={`Remove ${f.label || 'this field'}`} onRemove={() => onChange(fields.filter((_, j) => j !== i))}>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_14rem]">
            <Field label="Label"><Input maxLength={40} value={f.label} placeholder={placeholder} disabled={disabled} onChange={(e) => upd(i, { label: e.target.value })} /></Field>
            <Field label="Kind">
              <Select value={f.kind} disabled={disabled} onChange={(e) => {
                const kind = e.target.value as CustomField['kind'];
                upd(i, { kind, options: dropdown(kind) ? f.options ?? [] : undefined });
              }}>
                {CUSTOM_FIELD_KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
              </Select>
            </Field>
            {dropdown(f.kind) && (
              <Field label="Choices" hint="One per line, in the order shown. At least two." className="sm:col-span-2">
                <Textarea rows={3} disabled={disabled} value={(f.options ?? []).join('\n')}
                  onChange={(e) => upd(i, { options: e.target.value.split('\n').map((x) => x.replace(/\|/g, '/')).slice(0, 30) })}
                  onBlur={() => upd(i, { options: (f.options ?? []).map((x) => x.trim()).filter(Boolean) })} />
              </Field>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
            <Checkbox id={`${id}-${f.id}-required`} label="Must be filled in" checked={!!f.required} disabled={disabled} onCheckedChange={(v) => upd(i, { required: v || undefined })} />
            <Checkbox id={`${id}-${f.id}-column`} label="Show as a column on the list" checked={!!f.column} disabled={disabled} onCheckedChange={(v) => upd(i, { column: v || undefined })} />
            <span className="ml-auto flex gap-1">
              <Button type="button" size="icon" variant="ghost" aria-label={`Move ${f.label || 'this field'} up`} disabled={disabled || i === 0} onClick={() => move(i, -1)}><ArrowUp /></Button>
              <Button type="button" size="icon" variant="ghost" aria-label={`Move ${f.label || 'this field'} down`} disabled={disabled || i === fields.length - 1} onClick={() => move(i, 1)}><ArrowDown /></Button>
            </span>
          </div>
        </Item>
      ))}
    </Section>
  );
}

/** The fields without rows left empty, and dropdown choices without blank lines. */
export const cleanFields = (fields: CustomField[]) => fields
  .filter((f) => f.label.trim())
  .map((f) => (dropdown(f.kind) ? { ...f, options: (f.options ?? []).map((x) => x.trim()).filter(Boolean) } : f));
