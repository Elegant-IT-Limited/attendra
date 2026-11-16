// SPDX-License-Identifier: AGPL-3.0-only

/** "1 row", "2 rows": a count with its noun, one or many (note 2026-11-16 item 6: "Checked 1 rows"). */
export const rowsWord = (n: number) => `${n} ${n === 1 ? 'row' : 'rows'}`;

type Counts = { add: number; update: number; skip: number; error: number };

/** What a check of an import file found, before anything is imported (pets and vets alike). */
export function checkedLine(rows: number, c: Counts): string {
  const problem = c.error === 0 ? ''
    : c.error === 1 ? ' The row with a problem is left out; fix it in the file and upload it again.'
    : ' Rows with a problem are left out; fix them in the file and upload it again.';
  return `Checked ${rowsWord(rows)}: ${c.add} new, ${c.update} to update, ${c.skip} already on file, ${c.error} with a problem.${problem}`;
}

/** What an import did. */
export const importedLine = (c: Counts) => `Imported: ${c.add} new, ${c.update} updated, ${c.skip} already on file, ${c.error} not imported.`;
