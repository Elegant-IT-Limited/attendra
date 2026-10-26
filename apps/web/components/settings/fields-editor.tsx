// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { ReactNode } from 'react';
import { CUSTOM_FIELD_KINDS, type CustomField } from '@attendra/core';
import { Minus, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { EmptyNote, Field, Item, Section, TeamOnly } from '@/components/settings/section';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/controls';
import { Input, Select } from '@/components/ui/input';
import { moved, Sortable } from '@/components/ui/sortable';

export const KIND_LABELS: Record<CustomField['kind'], string> = {
  text: 'Text', number: 'Number', yesno: 'Yes or no', date: 'Date', choice: 'Dropdown (pick one)', multi: 'Dropdown (pick several)',
};
const dropdown = (k: CustomField['kind']) => k === 'choice' || k === 'multi';
const newFieldId = () => `field_${Math.random().toString(36).slice(2, 8)}`;

/**
 * The clinic's own fields on one kind of record: a label, a kind (dropdowns with their
 * choices), whether it must be filled in, and whether it shows as a column. A new field
 * goes to the top with the cursor in it; with an empty one already there, the button
 * goes to that one instead. Fields and a dropdown's choices are put in order by dragging.
 * Dropdowns and yes-or-no fields become filters on the list.
 */
export function FieldsEditor({ id, title, description, fields, onChange, disabled, placeholder, builtIn, footer, columnLabel, tellsCallers, teamOnly }: {
  id: string; title: string; description: string; fields: CustomField[]; onChange: (fields: CustomField[]) => void; disabled: boolean; placeholder: string;
  /** What "show it" means on this kind of record ("Show on the Pets list"); left out where every field always shows. */
  columnLabel?: string;
  /** Each field has "The assistant may tell callers", on unless the clinic keeps it for the team: a doctor's or vet's fields only. */
  tellsCallers?: boolean;
  /** Fields callers never hear about (pets', patients' and requests'): says so under the title. */
  teamOnly?: boolean;
  /** The fields every record has anyway, shown so nobody adds them twice. */
  builtIn?: readonly string[];
  /** The section's own Save, like every list's. */
  footer?: ReactNode;
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
      {teamOnly && <TeamOnly />}
      {builtIn && builtIn.length > 0 && <BuiltIn names={builtIn} />}
      {!fields.length && <EmptyNote>No fields of your own yet. Add one for anything you keep that has no place yet.</EmptyNote>}
      <Sortable items={fields} keyOf={(f) => f.id} label={(f) => f.label} disabled={disabled} onMove={(from, to) => onChange(moved(fields, from, to))} className="space-y-5">
      {(f, i, handle) => (
        <Item handle={handle} id={`${id}-${f.id}`} removeLabel={`Remove ${f.label || 'this field'}`} onRemove={() => onChange(fields.filter((_, j) => j !== i))}>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_14rem]">
            <Field label="Name"><Input maxLength={40} value={f.label} placeholder={placeholder} disabled={disabled} onChange={(e) => upd(i, { label: e.target.value })} /></Field>
            <Field label="Kind">
              <Select value={f.kind} disabled={disabled} onChange={(e) => {
                const kind = e.target.value as CustomField['kind'];
                upd(i, { kind, options: dropdown(kind) ? (f.options?.length ? f.options : ['', '']) : undefined });
              }}>
                {CUSTOM_FIELD_KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
              </Select>
            </Field>
            {dropdown(f.kind) && (
              <div className="space-y-1.5 sm:col-span-2">
                <p className="text-sm font-medium">Choices</p>
                <Choices field={f.label} options={f.options ?? []} disabled={disabled} onChange={(options) => upd(i, { options })} />
                <p className="text-xs text-text-muted">At least two, in the order shown. + adds a row below, − removes one, drag to reorder. Enter adds the next row.</p>
              </div>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
            <Checkbox id={`${id}-${f.id}-required`} label="Must be filled in" checked={!!f.required} disabled={disabled} onCheckedChange={(v) => upd(i, { required: v || undefined })} />
            {columnLabel && <Checkbox id={`${id}-${f.id}-column`} label={columnLabel} checked={!!f.column} disabled={disabled} onCheckedChange={(v) => upd(i, { column: v || undefined })} />}
            {tellsCallers && <Checkbox id={`${id}-${f.id}-tell`} label="The assistant may tell callers" checked={f.tellCallers !== false} disabled={disabled} onCheckedChange={(v) => upd(i, { tellCallers: v ? undefined : false })} />}
          </div>
        </Item>
      )}
      </Sortable>
      {footer}
    </Section>
  );
}

/** The fields without rows left empty, and dropdown choices without blank lines. */
export const cleanFields = (fields: CustomField[]) => fields
  .filter((f) => f.label.trim())
  .map((f) => (dropdown(f.kind) ? { ...f, options: (f.options ?? []).map((x) => x.trim()).filter(Boolean) } : f));

/**
 * A dropdown's choices, one row each, like a spreadsheet's rows: type in the row, + adds
 * an empty row under it, − removes it, and the handle drags it into place. Empty rows are
 * dropped on save; a choice typed twice is marked on its row.
 */
function Choices({ field, options, disabled, onChange }: { field: string; options: string[]; disabled: boolean; onChange: (options: string[]) => void }) {
  // a steady id per row, so typing in a row or dragging it keeps the cursor where it is
  const ids = useRef<string[]>([]);
  const nextId = useRef(0);
  while (ids.current.length < options.length) ids.current.push(`choice-${++nextId.current}`);
  ids.current.length = options.length;
  const [focus, setFocus] = useState<number | null>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus === null) return;
    list.current?.querySelectorAll<HTMLInputElement>('input[data-choice]')[focus]?.focus();
    setFocus(null);
  }, [focus, options]);

  const rows = options.length ? options : [''];
  const seen = rows.map((o, i) => !!o.trim() && rows.findIndex((x) => x.trim().toLowerCase() === o.trim().toLowerCase()) !== i);
  const set = (i: number, v: string) => onChange(rows.map((x, j) => (j === i ? v.replace(/\|/g, '/') : x)));
  const addBelow = (i: number) => {
    if (rows.length >= 30) return;
    ids.current.splice(i + 1, 0, `choice-${++nextId.current}`);
    onChange([...rows.slice(0, i + 1), '', ...rows.slice(i + 1)]);
    setFocus(i + 1);
  };
  const remove = (i: number) => {
    ids.current.splice(i, 1);
    onChange(rows.length > 1 ? rows.filter((_, j) => j !== i) : ['']);
    setFocus(Math.max(0, i - 1));
  };
  return (
    <div ref={list}>
      <Sortable items={rows} keyOf={(_o, i) => ids.current[i] ?? `choice-row-${i}`} label={(o) => o || 'this choice'} disabled={disabled}
        onMove={(from, to) => { ids.current = moved(ids.current, from, to); onChange(moved(rows, from, to)); }} className="space-y-2" itemClassName="flex items-center gap-2">
        {(o, i, handle) => (
          <>
            {handle ?? <span className="size-8 shrink-0" aria-hidden />}
            <div className="min-w-0 flex-1">
              <Input data-choice maxLength={60} value={o} disabled={disabled} placeholder={`Choice ${i + 1}`} aria-label={`${field || 'Dropdown'}: choice ${i + 1}`} aria-invalid={seen[i] || undefined}
                onChange={(e) => set(i, e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addBelow(i); } }} />
              {seen[i] && <p className="mt-1 text-xs text-danger">Already a choice above.</p>}
            </div>
            <Button type="button" size="icon" variant="outline" aria-label={`Add a choice after ${o || `choice ${i + 1}`}`} disabled={disabled || rows.length >= 30} onClick={() => addBelow(i)}><Plus /></Button>
            <Button type="button" size="icon" variant="outline" className="text-text-muted hover:text-danger" aria-label={`Remove ${o || `choice ${i + 1}`}`} disabled={disabled || (rows.length === 1 && !o)} onClick={() => remove(i)}><Minus /></Button>
          </>
        )}
      </Sortable>
    </div>
  );
}

/** Built into every record: listed, never edited here, so the clinic's own fields do not repeat them. */
export function BuiltIn({ names, label = 'Always on each record' }: { names: readonly string[]; label?: string }) {
  return (
    <div className="rounded-md border border-border bg-surface-sunken/60 px-4 py-3 text-sm" data-testid="built-in">
      <p className="font-medium">{label}</p>
      <ul className="mt-2 flex flex-wrap gap-1.5">{names.map((n) => <li key={n} className="rounded-full border border-border bg-surface px-2.5 py-0.5 text-text-muted">{n}</li>)}</ul>
    </div>
  );
}
