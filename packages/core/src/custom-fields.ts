// SPDX-License-Identifier: AGPL-3.0-only
import type { CustomField } from './clinic';

export const CUSTOM_TEXT_MAX = 200;

/**
 * Checks the values staff typed for a record against the clinic's own fields: the
 * whole set, which replaces what the record had. An empty value leaves the field
 * blank; a value for a field the clinic does not have is an error.
 */
export function readCustomValues(fields: CustomField[], values: Record<string, string>):
  { ok: true; values: Record<string, string> } | { ok: false; field: string; message: string } {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const out: Record<string, string> = {};
  for (const [id, raw] of Object.entries(values)) {
    const f = byId.get(id);
    if (!f) return { ok: false, field: id, message: 'this clinic has no such field' };
    const v = raw.trim();
    if (!v) continue;
    if (f.kind === 'yesno' && v !== 'yes' && v !== 'no') return { ok: false, field: id, message: 'yes or no' };
    if (f.kind === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return { ok: false, field: id, message: 'a date as YYYY-MM-DD' };
    if (v.length > CUSTOM_TEXT_MAX) return { ok: false, field: id, message: `at most ${CUSTOM_TEXT_MAX} characters` };
    out[id] = v;
  }
  return { ok: true, values: out };
}
