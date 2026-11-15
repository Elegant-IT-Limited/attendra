// SPDX-License-Identifier: AGPL-3.0-only
import type { ChoiceRenames, CustomField } from '@attendra/core';

const dropdown = (k: CustomField['kind']) => k === 'choice' || k === 'multi';

/**
 * A field as the page edits it: `was`, row by row, what each dropdown choice was called when the page opened (null for
 * a row added since), so a rename is carried to the records that have the old name. Absent until a choice is edited:
 * every choice is then still as saved.
 */
export type EditedField = CustomField & { was?: (string | null)[] };

/** The renamed choices on a kind of record's fields: { field id: { old name: new name } }. A removed row is no rename. */
export function choiceRenames(fields: EditedField[]): ChoiceRenames {
  const out: ChoiceRenames = {};
  for (const f of fields) {
    if (!f.was || !dropdown(f.kind)) continue;
    const pairs = (f.options ?? []).flatMap((o, i) => { const was = f.was![i]; return was && o.trim() && was !== o.trim() ? [[was, o.trim()] as const] : []; });
    if (pairs.length) out[f.id] = Object.fromEntries(pairs);
  }
  return out;
}

/** The fields as they are saved: without what the page keeps for itself. */
export const savedFields = (fields: EditedField[]): CustomField[] => fields.map(({ was: _was, ...f }) => f);
