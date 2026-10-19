// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { ClinicConfig, ListName } from '@attendra/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { EmptyNote, Section } from '@/components/settings/section';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { moved, Sortable } from '@/components/ui/sortable';
import { useConfirm, useProblem, useToast } from '@/components/ui/toast';
import { api, ApiFailure } from '@/lib/api';

/**
 * One of the clinic's lists, kept in order: add (at the top), rename, remove, and drag
 * to reorder. Saved whole with its own button, and carried to every record that uses it
 * (a renamed specialty is renamed on each doctor; a removed one is taken off them, after
 * asking, with how many use it).
 */
export function ListEditor({ clinicId, name, id, title, description, values, usage, disabled, placeholder, onSaved }: {
  clinicId: string; name: ListName; id: string; title: string; description: string; values: string[];
  /** How many records use each value, by lower-cased value. */
  usage: Record<string, number>; disabled: boolean; placeholder: string; onSaved: (config: ClinicConfig) => void;
}) {
  const queries = useQueryClient();
  const toast = useToast();
  const problem = useProblem();
  const confirm = useConfirm();
  // each row remembers what it was called when the page opened, so a rename is carried over
  // `id` stays with a row while it is renamed or dragged
  const fresh = () => values.map((v) => ({ value: v, was: v as string | null, id: `was:${v}` }));
  const [rows, setRows] = useState(fresh);
  const [adding, setAdding] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const key = values.join('\n');
  useEffect(() => { setRows(key ? key.split('\n').map((v) => ({ value: v, was: v as string | null, id: `was:${v}` })) : []); }, [key]);
  const dirty = JSON.stringify(rows.map((r) => r.value)) !== JSON.stringify(values);

  const save = useMutation({
    mutationFn: () => {
      const renamed = Object.fromEntries(rows.filter((r) => r.was && r.was !== r.value.trim()).map((r) => [r.was!, r.value.trim()]));
      return api<ClinicConfig>(`/clinics/${clinicId}/settings/lists/${name}`, { method: 'PUT', body: JSON.stringify({ values: rows.map((r) => r.value.trim()).filter(Boolean), renamed }) });
    },
    onSuccess: (config) => {
      setEditing(null);
      onSaved(config);
      void queries.invalidateQueries({ queryKey: ['doctors', clinicId] });
      // the save moved the settings' version on: every copy of them is out of date now
      void queries.invalidateQueries({ queryKey: ['settings', clinicId] });
      void queries.invalidateQueries({ queryKey: ['settings-versioned', clinicId] });
      toast({ tone: 'success', message: `${title} saved.` });
    },
    onError: (e) => problem({ title: `${title}: not saved`, message: e instanceof ApiFailure ? (e.body.issues?.[0]?.message ?? e.message) : 'The list did not reach the server. Check your connection and save again.' }),
  });

  const remove = async (i: number) => {
    const r = rows[i]!;
    const used = r.was ? usage[r.was.toLowerCase()] ?? 0 : 0;
    if (used && !(await confirm({
      title: `Remove ${r.value}?`, tone: 'danger', confirmLabel: 'Remove',
      message: `${r.value} is used on ${used} ${used === 1 ? 'record' : 'records'}. Saving the list takes it off ${used === 1 ? 'it' : 'them'} too.`,
    }))) return;
    setRows(rows.filter((_, j) => j !== i));
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    const v = adding.trim();
    if (!v) return;
    if (rows.some((r) => r.value.trim().toLowerCase() === v.toLowerCase())) { problem({ title: 'Already on the list', message: `${v} is already on ${title.toLowerCase()}.` }); return; }
    // a new one goes to the top, where it is seen; drag it to its place
    setRows([{ value: v, was: null, id: `new:${Date.now()}:${v}` }, ...rows]);
    setAdding('');
  };

  return (
    <Section id={id} title={title} description={description}>
      <form onSubmit={add} className="flex gap-2">
        <Input maxLength={40} className="flex-1" value={adding} placeholder={placeholder} disabled={disabled || rows.length >= 60} aria-label={`Add to ${title}`} onChange={(e) => setAdding(e.target.value)} />
        <Button type="submit" variant="outline" disabled={disabled || !adding.trim()}><Plus /> Add</Button>
      </form>
      {!rows.length && <EmptyNote>Nothing on this list yet.</EmptyNote>}
      {rows.length > 0 && (
        <Sortable as="ul" items={rows} keyOf={(r) => r.id} label={(r) => r.value} disabled={disabled} onMove={(f, t) => setRows(moved(rows, f, t))}
          className="divide-y divide-border rounded-lg border border-border bg-surface" itemClassName="flex items-center gap-2 px-2 py-2">
          {(r, i, handle) => {
            const used = r.was ? usage[r.was.toLowerCase()] ?? 0 : 0;
            return (
              <>
                {handle}
                {editing === i ? (
                  <Input autoFocus maxLength={40} className="h-8 flex-1" value={r.value} aria-label={`New name for ${r.was ?? r.value}`}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setEditing(null); } }} onBlur={() => setEditing(null)} />
                ) : (
                  <span className="flex-1 px-1 text-sm">
                    {r.value}
                    {r.was && r.was !== r.value && <span className="ml-2 text-xs text-text-muted">was {r.was}</span>}
                    {!r.was && <span className="ml-2 text-xs text-text-muted">new</span>}
                    {used > 0 && <span className="ml-2 text-xs text-text-muted">used on {used}</span>}
                  </span>
                )}
                <Button type="button" size="icon" variant="ghost" aria-label={`Rename ${r.value}`} disabled={disabled} onClick={() => setEditing(i)}><Pencil /></Button>
                <Button type="button" size="icon" variant="ghost" className="text-text-muted hover:text-danger" aria-label={`Remove ${r.value}`} disabled={disabled} onClick={() => void remove(i)}><Trash2 /></Button>
              </>
            );
          }}
        </Sortable>
      )}
      {dirty && (
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setRows(fresh())}>Discard</Button>
          <Button type="button" disabled={disabled || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : `Save ${title.toLowerCase()}`}</Button>
        </div>
      )}
    </Section>
  );
}
