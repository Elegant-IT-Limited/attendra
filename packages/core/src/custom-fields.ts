// SPDX-License-Identifier: AGPL-3.0-only
import type { CustomField } from './clinic';

export const CUSTOM_TEXT_MAX = 200;

/** A multi-choice value, as stored: its choices joined with " | ". */
export const MULTI_SEPARATOR = ' | ';
export const multiValues = (v: string | undefined) => (v ? v.split('|').map((x) => x.trim()).filter(Boolean) : []);

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
