// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { ImportResult } from '@attendra/api/contracts';
import { useMutation } from '@tanstack/react-query';
import { Download, FileUp } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/dialog';
import { Alert } from '@/components/ui/feedback';
import { api, ApiFailure } from '@/lib/api';

const STATUS: Record<ImportResult['rows'][number]['status'], { label: string; tone: 'ok' | 'info' | 'neutral' | 'danger' }> = {
  add: { label: 'New', tone: 'ok' },
  update: { label: 'Update', tone: 'info' },
  skip: { label: 'Already on file', tone: 'neutral' },
  error: { label: 'Not imported', tone: 'danger' },
};

/** Saves text as a file in the browser: the template a manager fills in. */
function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Upload a list from a spreadsheet, as CSV. First every row is checked and the result
 * shown, with nothing changed; then the manager imports the rows that passed. The
 * template and its guide are one click away, so the file matches what the import reads.
 */
export function ImportPanel({ open, onOpenChange, title, what, endpoint, template, guide, onImported }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** "doctors" or "patients", for the sentences around the table. */
  what: string;
  endpoint: string;
  template: { name: string; csv: string };
  guide: readonly string[];
  onImported?: (r: ImportResult) => void;
}) {
  const [file, setFile] = useState<{ name: string; csv: string } | null>(null);
  const [checked, setChecked] = useState<ImportResult | null>(null);
  const [done, setDone] = useState<ImportResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: (dryRun: boolean) => api<ImportResult>(endpoint, { method: 'POST', body: JSON.stringify({ csv: file!.csv, dryRun }) }),
    onMutate: () => setProblem(null),
    onSuccess: (r) => { if (r.dryRun) setChecked(r); else { setDone(r); onImported?.(r); } },
    onError: (e) => setProblem(e instanceof ApiFailure ? (e.body.issues?.map((i) => i.message).join('. ') || e.body.message || 'The import did not work.') : 'The import did not work. Check your connection and try again.'),
  });
  const reset = () => { setFile(null); setChecked(null); setDone(null); setProblem(null); };
  const result = done ?? checked;
  const ready = checked ? checked.counts.add + checked.counts.update : 0;

  return (
    <Panel open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }} title={title} className="max-w-3xl"
      description={`Add many ${what} at once from a spreadsheet saved as CSV. Nothing changes until you press Import.`}
      footer={done ? <Button onClick={() => { reset(); onOpenChange(false); }}>Done</Button> : (
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          {checked
            ? <Button disabled={!ready || run.isPending} onClick={() => run.mutate(false)}>{run.isPending ? 'Importing…' : `Import ${ready} ${ready === 1 ? 'row' : 'rows'}`}</Button>
            : <Button disabled={!file || run.isPending} onClick={() => run.mutate(true)}>{run.isPending ? 'Checking…' : 'Check the file'}</Button>}
        </>
      )}>
      <div className="space-y-4">
        {!result && (
          <>
            <div className="rounded-md border border-border bg-surface-sunken p-4 text-sm">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">How to fill in the template</p>
                <Button size="sm" variant="outline" onClick={() => download(template.name, template.csv)}><Download /> Download template</Button>
              </div>
              <ol className="list-decimal space-y-1 pl-5 text-text-muted">{guide.map((g) => <li key={g}>{g}</li>)}</ol>
            </div>
            <label className="flex cursor-pointer flex-col items-center gap-2 rounded-md border border-dashed border-border-strong p-6 text-sm hover:bg-surface-sunken">
              <FileUp className="size-5 text-text-muted" aria-hidden />
              <span>{file ? file.name : 'Choose a CSV file'}</span>
              <input type="file" accept=".csv,text/csv" className="sr-only" onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                if (f.size > 2_000_000) { setProblem('That file is larger than 2 MB. Split it into smaller files.'); return; }
                setFile({ name: f.name, csv: await f.text() });
              }} />
            </label>
          </>
        )}
        {problem && <Alert tone="warn">{problem}</Alert>}
        {result && (
          <>
            <Alert tone={done ? 'ok' : result.counts.error ? 'warn' : 'info'}>
              {done
                ? `Imported: ${done.counts.add} new, ${done.counts.update} updated, ${done.counts.skip} already on file, ${done.counts.error} not imported.`
                : `Checked ${result.rows.length} rows: ${result.counts.add} new, ${result.counts.update} to update, ${result.counts.skip} already on file, ${result.counts.error} with a problem. Rows with a problem are left out; fix them in the file and upload it again.`}
            </Alert>
            <div className="max-h-80 overflow-y-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-surface text-left text-xs text-text-muted"><tr><th className="px-3 py-2">Row</th><th className="px-3 py-2">Name</th><th className="px-3 py-2">Result</th></tr></thead>
                <tbody className="divide-y divide-border">
                  {result.rows.map((r) => (
                    <tr key={r.line}>
                      <td className="px-3 py-2 tabular-nums text-text-muted">{r.line}</td>
                      <td className="px-3 py-2">{r.name || 'Unnamed'}</td>
                      <td className="px-3 py-2"><Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>{r.message && <span className="ml-2 text-text-muted">{r.message}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}
