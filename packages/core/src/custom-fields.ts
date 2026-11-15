// SPDX-License-Identifier: AGPL-3.0-only
import type { CustomField } from './clinic';

export const CUSTOM_TEXT_MAX = 200;

/** A multi-choice value, as stored: its choices joined with " | ". */
export const MULTI_SEPARATOR = ' | ';
export const multiValues = (v: string | undefined) => (v ? v.split('|').map((x) => x.trim()).filter(Boolean) : []);

/** Whether the assistant may tell any caller a doctor's or vet's own field: yes, unless the clinic keeps it for the team. */
export const tellsCallers = (f: Pick<CustomField, 'tellCallers'>) => f.tellCallers !== false;

/**
 * A doctor's or vet's own details as any caller may hear them, under the clinic's labels:
 * { "Qualifications": "DVM, 12 years with small animals" }. Fields kept for the team, fields
 * the clinic removed and empty ones are left out; a multi-choice value reads as a list.
 */
export function sharedCustomFacts(fields: CustomField[] | undefined, values: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields ?? []) {
    const v = values?.[f.id]?.trim();
    if (!v || !tellsCallers(f)) continue;
    out[f.label] = f.kind === 'multi' ? multiValues(v).join(', ') : v;
  }
  return out;
}

/**
 * Checks the values staff typed for a record against the clinic's own fields: the
 * whole set, which replaces what the record had. An empty value leaves the field
 * blank; a value for a field the clinic does not have is an error. With `complete`,
 * the form sent every field, so a required one left empty is an error too.
 */
export function readCustomValues(fields: CustomField[], values: Record<string, string>, opts: { complete?: boolean } = {}):
  { ok: true; values: Record<string, string> } | { ok: false; field: string; message: string } {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const out: Record<string, string> = {};
  for (const [id, raw] of Object.entries(values)) {
    const f = byId.get(id);
    if (!f) return { ok: false, field: id, message: 'this clinic has no such field' };
    const v = raw.trim();
    if (!v) continue;
    if (v.length > CUSTOM_TEXT_MAX) return { ok: false, field: id, message: `at most ${CUSTOM_TEXT_MAX} characters` };
    if (f.kind === 'yesno' && v !== 'yes' && v !== 'no') return { ok: false, field: id, message: 'yes or no' };
    if (f.kind === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return { ok: false, field: id, message: 'a date as YYYY-MM-DD' };
    if (f.kind === 'number' && !/^-?\d+(\.\d+)?$/.test(v)) return { ok: false, field: id, message: 'a number' };
    if (f.kind === 'choice') {
      const o = (f.options ?? []).find((x) => x.toLowerCase() === v.toLowerCase());
      if (!o) return { ok: false, field: id, message: 'one of the choices' };
      out[id] = o;
      continue;
    }
    if (f.kind === 'multi') {
      const picked = multiValues(v).map((p) => (f.options ?? []).find((x) => x.toLowerCase() === p.toLowerCase()));
      if (picked.some((p) => !p)) return { ok: false, field: id, message: 'only the listed choices' };
      // in the order the clinic lists them, once each
      out[id] = (f.options ?? []).filter((o) => picked.includes(o)).join(MULTI_SEPARATOR);
      continue;
    }
    out[id] = v;
  }
  if (opts.complete) {
    const missing = fields.find((f) => f.required && !out[f.id]);
    if (missing) return { ok: false, field: missing.id, message: 'required' };
  }
  return { ok: true, values: out };
}

/** Renamed choices of the clinic's own dropdowns, by field id: { insurer: { "Old name": "New name" } }. */
export type ChoiceRenames = Record<string, Record<string, string>>;

/**
 * One record's own details with renamed dropdown choices carried over (Settings, Fields and lists): a value that was
 * a renamed choice, whatever its case, becomes the new name; a multi-choice value is renamed choice by choice and
 * kept in the order the clinic lists them. Any other value is left as it is, so a removed choice stays on the record as
 * it did before. Null when nothing changes.
 */
export function withRenamedChoices(fields: CustomField[], values: Record<string, string>, renamed: ChoiceRenames): Record<string, string> | null {
  let changed = false;
  const out = { ...values };
  for (const f of fields) {
    const map = renamed[f.id];
    const v = values[f.id];
    if (!map || !v || (f.kind !== 'choice' && f.kind !== 'multi')) continue;
    const to = (x: string) => map[x] ?? Object.entries(map).find(([from]) => from.toLowerCase() === x.toLowerCase())?.[1] ?? x;
    const parts = f.kind === 'choice' ? [v.trim()] : multiValues(v);
    if (parts.every((x) => to(x) === x)) continue;
    const picked = new Set(parts.map(to));
    // in the order the clinic lists its choices, then any it no longer lists, as they were
    out[f.id] = f.kind === 'choice' ? [...picked][0]! : [...(f.options ?? []).filter((o) => picked.has(o)), ...[...picked].filter((x) => !(f.options ?? []).includes(x))].join(MULTI_SEPARATOR);
    changed = true;
  }
  return changed ? out : null;
}

/**
 * The renames that can be carried: only to a choice the field still lists (as it lists it), and only for a dropdown.
 * A rename to nothing, to a choice no longer listed, or of a field the clinic no longer has is dropped.
 */
export function carriedRenames(fields: CustomField[], renamed: ChoiceRenames): ChoiceRenames {
  const out: ChoiceRenames = {};
  for (const f of fields) {
    if ((f.kind !== 'choice' && f.kind !== 'multi') || !renamed[f.id]) continue;
    const pairs = Object.entries(renamed[f.id]!).flatMap(([from, to]) => {
      const listed = (f.options ?? []).find((o) => o.toLowerCase() === to.trim().toLowerCase());
      return listed && from.trim() && from !== listed ? [[from.trim(), listed] as const] : [];
    });
    if (pairs.length) out[f.id] = Object.fromEntries(pairs);
  }
  return out;
}
