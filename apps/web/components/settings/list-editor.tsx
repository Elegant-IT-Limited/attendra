// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { ClinicConfig, ListName } from '@attendra/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { EmptyNote, Section } from '@/components/settings/section';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { api, ApiFailure } from '@/lib/api';

/**
 * One of the clinic's lists, kept in order: add, rename, remove, move. Saved whole with
 * its own button, and carried to every record that uses it (a renamed specialty is
 * renamed on each doctor; a removed one is taken off them, after saying how many).
 */
export function ListEditor({ clinicId, name, id, title, description, values, usage, disabled, placeholder, onSaved }: {
  clinicId: string; name: ListName; id: string; title: string; description: string; values: string[];
  /** How many records use each value, by lower-cased value. */
  usage: Record<string, number>; disabled: boolean; placeholder: string; onSaved: (config: ClinicConfig) => void;
}) {
  const queries = useQueryClient();
  const toast = useToast();
  // each row remembers what it was called when the page opened, so a rename is carried over
  const fresh = () => values.map((v) => ({ value: v, was: v as string | null }));
  const [rows, setRows] = useState(fresh);
  const [adding, setAdding] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const key = values.join('\n');
  useEffect(() => { setRows(key ? key.split('\n').map((v) => ({ value: v, was: v })) : []); }, [key]);
  const dirty = JSON.stringify(rows.map((r) => r.value)) !== JSON.stringify(values);

  const save = useMutation({
    mutationFn: () => {
      const renamed = Object.fromEntries(rows.filter((r) => r.was && r.was !== r.value.trim()).map((r) => [r.was!, r.value.trim()]));
      return api<ClinicConfig>(`/clinics/${clinicId}/settings/lists/${name}`, { method: 'PUT', body: JSON.stringify({ values: rows.map((r) => r.value.trim()).filter(Boolean), renamed }) });
    },
    onMutate: () => setProblem(null),
    onSuccess: (config) => {
      setEditing(null);
      onSaved(config);
      void queries.invalidateQueries({ queryKey: ['doctors', clinicId] });
      toast({ tone: 'success', message: `${title} saved.` });
    },
    onError: (e) => setProblem(e instanceof ApiFailure ? (e.body.issues?.[0]?.message ?? e.message) : 'Not saved. Try again.'),
  });

  const move = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setRows(next);
  };
  const remove = (i: number) => {
    const r = rows[i]!;
    const used = r.was ? usage[r.was.toLowerCase()] ?? 0 : 0;
    if (used && !window.confirm(`${r.value} is used on ${used} ${used === 1 ? 'record' : 'records'}. Remove it from the list and from ${used === 1 ? 'it' : 'them'}?`)) return;
    setRows(rows.filter((_, j) => j !== i));
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    const v = adding.trim();
    if (!v) return;
    if (rows.some((r) => r.value.trim().toLowerCase() === v.toLowerCase())) { setProblem(`${v} is already on the list.`); return; }
    setRows([...rows, { value: v, was: null }]);
    setAdding('');
    setProblem(null);
  };

  return (
    <Section id={id} title={title} description={description}>
      {problem && <Alert tone="warn">{problem}</Alert>}
      {!rows.length && <EmptyNote>Nothing on this list yet.</EmptyNote>}
      {rows.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {rows.map((r, i) => {
            const used = r.was ? usage[r.was.toLowerCase()] ?? 0 : 0;
            return (
              <li key={`${r.was ?? 'new'}-${i}`} className="flex items-center gap-2 px-3 py-2">
                {editing === i ? (
                  <Input autoFocus maxLength={40} className="h-8 flex-1" value={r.value} aria-label={`New name for ${r.was ?? r.value}`}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setEditing(null); } }} onBlur={() => setEditing(null)} />
                ) : (
                  <span className="flex-1 text-sm">
                    {r.value}
                    {r.was && r.was !== r.value && <span className="ml-2 text-xs text-text-muted">was {r.was}</span>}
                    {used > 0 && <span className="ml-2 text-xs text-text-muted">used on {used}</span>}
                  </span>
                )}
                <Button type="button" size="icon" variant="ghost" aria-label={`Rename ${r.value}`} disabled={disabled} onClick={() => setEditing(i)}><Pencil /></Button>
                <Button type="button" size="icon" variant="ghost" aria-label={`Move ${r.value} up`} disabled={disabled || i === 0} onClick={() => move(i, -1)}><ArrowUp /></Button>
                <Button type="button" size="icon" variant="ghost" aria-label={`Move ${r.value} down`} disabled={disabled || i === rows.length - 1} onClick={() => move(i, 1)}><ArrowDown /></Button>
                <Button type="button" size="icon" variant="ghost" className="text-text-muted hover:text-danger" aria-label={`Remove ${r.value}`} disabled={disabled} onClick={() => remove(i)}><Trash2 /></Button>
              </li>
            );
          })}
        </ul>
      )}
      <form onSubmit={add} className="flex gap-2">
        <Input maxLength={40} className="flex-1" value={adding} placeholder={placeholder} disabled={disabled || rows.length >= 60} aria-label={`Add to ${title}`} onChange={(e) => setAdding(e.target.value)} />
        <Button type="submit" variant="outline" disabled={disabled || !adding.trim()}><Plus /> Add</Button>
      </form>
      {dirty && (
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => { setRows(fresh()); setProblem(null); }}>Discard</Button>
          <Button type="button" disabled={disabled || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : `Save ${title.toLowerCase()}`}</Button>
        </div>
      )}
    </Section>
  );
}
