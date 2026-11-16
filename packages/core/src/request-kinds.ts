// SPDX-License-Identifier: AGPL-3.0-only
import type { ClinicConfig } from './clinic';

type Kinds = ClinicConfig['requestTopics'];

/**
 * The clinic's own kinds of request renamed by a save: { old name: new name }, by each kind's id (note 2026-11-16, demo
 * findings 3: renaming "Boarding booking" left its requests on the old name). A kind removed or added is no rename;
 * requests of a removed kind keep their name, as F1 keeps a removed dropdown choice.
 */
export function requestKindRenames(before: Kinds, after: Kinds): Record<string, string> {
  const now = new Map((after ?? []).map((t) => [t.id, t.name.trim()]));
  const out: Record<string, string> = {};
  for (const t of before ?? []) {
    const name = now.get(t.id);
    if (name && name !== t.name.trim()) out[t.name.trim()] = name;
  }
  return out;
}
