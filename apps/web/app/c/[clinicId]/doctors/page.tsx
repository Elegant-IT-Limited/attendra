// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { DoctorInput, DoctorList } from '@attendra/api/contracts';
import { agesLine, DOCTOR_GUIDE, doctorTemplate, type Gender, genderWord, localDateOf, type Provider, type VisitType, weeklyHoursLine } from '@attendra/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarOff, FileUp, Plus, Search, Trash2, X } from 'lucide-react';
import { useParams } from 'next/navigation';
import { type FormEvent, useMemo, useState } from 'react';
import { ImportPanel } from '@/components/import-panel';
import { PageHeader } from '@/components/shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Panel } from '@/components/ui/dialog';
import { Alert, Empty, Skeleton } from '@/components/ui/feedback';
import { Input, Label, Select } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { api, ApiFailure, useClinic, useClinicConfig } from '@/lib/api';
import { dayTitle } from '@/lib/format';

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const DAYS = [['1', 'Monday'], ['2', 'Tuesday'], ['3', 'Wednesday'], ['4', 'Thursday'], ['5', 'Friday'], ['6', 'Saturday'], ['0', 'Sunday']] as const;
type Hours = NonNullable<Provider['hours']>;
type Draft = Omit<DoctorInput, 'gender'> & { gender: Gender | ''; ownHours: boolean };

const blank = (visitTypes: VisitType[]): Draft => ({
  name: '', kind: 'person', gender: '', specialty: '', categories: [], acceptingNewPatients: true, timeOff: [],
  visitTypeIds: visitTypes.slice(0, 1).map((v) => v.id), ownHours: false,
});
const draftOf = (p: Provider): Draft => ({ ...p, gender: p.gender ?? '', specialty: p.specialty ?? '', ownHours: !!p.hours });

/**
 * The clinic's doctors, and rooms booked like one. Everyone on the team can look;
 * managers add, change and remove them, set each one's weekly hours and days off, or
 * import a list. The assistant uses the list as it is now from the next thing a
 * caller asks, and every open screen shows a change without a refresh.
 */
export default function DoctorsPage() {
  const { clinicId } = useParams<{ clinicId: string }>();
  const { can, isPending } = useClinic(clinicId);
  const config = useClinicConfig(clinicId);
  const queries = useQueryClient();
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [importing, setImporting] = useState(false);
  const [text, setText] = useState('');
  const doctors = useQuery({ queryKey: ['doctors', clinicId], queryFn: () => api<DoctorList>(`/clinics/${clinicId}/doctors`), enabled: can('settings:read') });
  const manager = can('settings:write');
  const refresh = () => { void queries.invalidateQueries({ queryKey: ['doctors', clinicId] }); void queries.invalidateQueries({ queryKey: ['settings', clinicId] }); };
  const tz = config.data?.timezone ?? 'UTC';
  const today = localDateOf(new Date(), tz);
  const clinicHours = config.data?.hours ?? {};

  const shown = useMemo(() => {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    return (doctors.data?.providers ?? []).filter((p) => {
      const hay = [p.name, p.specialty ?? '', ...p.categories].join(' ').toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [doctors.data, text]);

  if (isPending || doctors.isPending) return <><PageHeader title="Doctors" /><Skeleton className="h-64" /></>;
  if (doctors.isError || !doctors.data) return <><PageHeader title="Doctors" /><Alert tone="danger">The list of doctors did not load. Refresh to try again.</Alert></>;
  const { visitTypes } = doctors.data;
  const visitName = (id: string) => visitTypes.find((v) => v.id === id)?.name ?? id;

  return (
    <>
      <PageHeader title="Doctors" description="Who can be booked, what they see people for, the ages they see, their weekly hours and days off. The assistant uses this list from the next thing a caller asks."
        actions={manager && (
          <>
            <Button variant="outline" onClick={() => setImporting(true)}><FileUp /> Import</Button>
            <Button onClick={() => setEditing({ id: null, draft: blank(visitTypes) })}><Plus /> Add doctor</Button>
          </>
        )} />
      <div className="relative mb-4 max-w-md">
        <Label htmlFor="doctor-search" className="sr-only">Find a doctor</Label>
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-muted" aria-hidden />
        <Input id="doctor-search" type="search" className="pl-9" autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} placeholder="Name, specialty or what they see people for" />
      </div>
      {!shown.length ? <Card><Empty title={text ? 'No doctor matches' : 'No doctors yet'}>{text ? 'Try another word.' : 'Add the first doctor, or import a list.'}</Empty></Card> : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((p) => {
            const away = p.timeOff.filter((t) => t.to >= today).sort((a, b) => a.from.localeCompare(b.from));
            return (
              <Card key={p.id} className="flex flex-col" data-testid="doctor">
                <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{p.name}</p>
                    <p className="text-sm text-text-muted">{[p.specialty || (p.kind === 'room' ? 'A room' : 'No specialty set'), p.gender && p.kind === 'person' ? capitalize(genderWord(p.gender)) : null].filter(Boolean).join(', ')}</p>
                  </div>
                  {p.acceptingNewPatients ? <Badge tone="ok">Takes new patients</Badge> : <Badge>No new patients</Badge>}
                </div>
                <dl className="grid flex-1 grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-5 py-4 text-sm">
                  <dt className="text-text-muted">Sees</dt><dd>{agesLine(p).replace(/^./, (c) => c.toUpperCase())}</dd>
                  {p.categories.length > 0 && <><dt className="text-text-muted">For</dt><dd className="flex flex-wrap content-start items-start gap-1">{p.categories.map((c) => <Badge key={c} tone="accent">{c}</Badge>)}</dd></>}
                  <dt className="text-text-muted">Books</dt><dd>{p.visitTypeIds.map(visitName).join(', ')}</dd>
                  <dt className="text-text-muted">Hours</dt><dd className="space-y-0.5">{weeklyHoursLine(p.hours ?? clinicHours).split('; ').map((line) => <span key={line} className="block">{line}</span>)}{!p.hours && <span className="block text-text-muted">The clinic&apos;s hours</span>}</dd>
                  {away.length > 0 && <><dt className="text-text-muted">Away</dt><dd className="space-y-0.5">{away.slice(0, 3).map((t) => <span key={t.from} className="flex items-center gap-1"><CalendarOff className="size-3.5 text-text-muted" aria-hidden />{t.from === t.to ? dayTitle(t.from) : `${dayTitle(t.from)} to ${dayTitle(t.to)}`}{t.note ? `, ${t.note}` : ''}</span>)}</dd></>}
                </dl>
                {manager && (
                  <div className="flex justify-end border-t border-border px-5 py-3">
                    <Button size="sm" variant="outline" onClick={() => setEditing({ id: p.id, draft: draftOf(p) })}>Edit hours and details</Button>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {editing && (
        <DoctorPanel clinicId={clinicId} editing={editing} visitTypes={visitTypes} clinicHours={clinicHours} today={today}
          onClose={() => setEditing(null)} onSaved={refresh} />
      )}
      <ImportPanel open={importing} onOpenChange={setImporting} title="Import doctors" what="doctors" endpoint={`/clinics/${clinicId}/doctors/import`}
        template={{ name: 'attendra-doctors-template.csv', csv: doctorTemplate({ visitTypes }) }} guide={DOCTOR_GUIDE} onImported={refresh} />
    </>
  );
}

function DoctorPanel({ clinicId, editing, visitTypes, clinicHours, today, onClose, onSaved }: {
  clinicId: string; editing: { id: string | null; draft: Draft }; visitTypes: VisitType[]; clinicHours: Hours; today: string;
  onClose: () => void; onSaved: () => void;
}) {
  const [d, setD] = useState<Draft>(editing.draft);
  const [categories, setCategories] = useState(editing.draft.categories.join(', '));
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const toast = useToast();
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const hours: Hours = d.hours ?? {};
  const failed = (e: unknown) => setProblem(e instanceof ApiFailure
    ? (e.body.issues?.map((i) => i.message).join('. ') || e.body.message || 'That did not save.')
    : 'That did not save. Check your connection and try again.');

  const save = useMutation({
    mutationFn: (body: DoctorInput) => api<DoctorList>(`/clinics/${clinicId}/doctors${editing.id ? `/${editing.id}` : ''}`, { method: editing.id ? 'PUT' : 'POST', body: JSON.stringify(body) }),
    onMutate: () => setProblem(null),
    onSuccess: () => { onSaved(); toast({ tone: 'success', message: editing.id ? 'Saved. The assistant uses it from the next request.' : 'Added. The assistant can book them from the next request.' }); onClose(); },
    onError: failed,
  });
  const remove = useMutation({
    mutationFn: () => api<DoctorList>(`/clinics/${clinicId}/doctors/${editing.id}`, { method: 'DELETE' }),
    onSuccess: () => { onSaved(); toast({ tone: 'success', message: 'Removed.' }); onClose(); },
    onError: failed,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const { ownHours, gender, ...rest } = d;
    if (!gender) { setProblem('Choose their gender, so callers who ask for a female or a male doctor are offered the right one.'); return; }
    save.mutate({
      ...rest,
      gender,
      name: d.name.trim(),
      specialty: d.specialty?.trim() || undefined,
      categories: categories.split(/[,;]/).map((c) => c.trim()).filter(Boolean),
      hours: ownHours ? Object.fromEntries(Object.entries(hours).filter(([, w]) => w && w.length)) : undefined,
      timeOff: d.timeOff.filter((t) => t.from && t.to),
    });
  };
  const setDay = (day: string, windows: { open: string; close: string }[]) => set({ hours: { ...hours, [day]: windows } });

  return (
    <Panel open onOpenChange={(o) => { if (!o) onClose(); }} side="right" title={editing.id ? `Edit ${editing.draft.name}` : 'Add doctor'}
      description="Saved changes reach the assistant on the next thing a caller asks."
      footer={(
        <>
          {editing.id && (confirmDelete
            ? <><span className="mr-auto self-center text-sm">Remove {editing.draft.name}?</span><Button variant="ghost" onClick={() => setConfirmDelete(false)}>No</Button><Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>Remove</Button></>
            : <Button variant="ghost" className="mr-auto" onClick={() => setConfirmDelete(true)}><Trash2 /> Remove</Button>)}
          {!confirmDelete && <><Button variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" form="doctor-form" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button></>}
        </>
      )}>
      <form id="doctor-form" onSubmit={submit} className="space-y-5">
        {problem && <Alert tone="warn">{problem}</Alert>}
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <div className="space-y-1.5"><Label htmlFor="doc-name">Name</Label><Input id="doc-name" required minLength={2} maxLength={80} value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="Dr. Jane Example" /></div>
          <div className="space-y-1.5"><Label htmlFor="doc-kind">Is a</Label>
            <Select id="doc-kind" value={d.kind} onChange={(e) => set({ kind: e.target.value as 'person' | 'room' })}><option value="person">Person</option><option value="room">Room</option></Select>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="doc-gender">Gender</Label>
          <Select id="doc-gender" required value={d.gender} onChange={(e) => set({ gender: e.target.value as Gender | '' })}>
            <option value="" disabled>Choose</option>
            <option value="female">Female</option><option value="male">Male</option><option value="other">Other</option><option value="undisclosed">Prefers not to say</option>
          </Select>
          <p className="text-xs text-text-muted">A caller can ask for a female or a male doctor.</p>
        </div>
        <div className="space-y-1.5"><Label htmlFor="doc-specialty">Specialty</Label><Input id="doc-specialty" maxLength={60} value={d.specialty ?? ''} onChange={(e) => set({ specialty: e.target.value })} placeholder="Family medicine, Pediatrics…" /></div>
        <div className="space-y-1.5">
          <Label htmlFor="doc-categories">What they see people for</Label>
          <Input id="doc-categories" value={categories} onChange={(e) => setCategories(e.target.value)} placeholder="Children, Vaccinations, Diabetes care" />
          <p className="text-xs text-text-muted">Separated by commas. The assistant tells callers, so they pick the right doctor.</p>
        </div>
        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium">Ages they see</legend>
          <div className="flex items-center gap-2 text-sm">
            <Label htmlFor="doc-age-min" className="text-text-muted">From</Label>
            <Input id="doc-age-min" type="number" min={0} max={120} className="w-20" value={d.ages?.min ?? ''} placeholder="0"
              onChange={(e) => set({ ages: e.target.value === '' && d.ages?.max == null ? undefined : { min: Number(e.target.value || 0), max: d.ages?.max ?? null } })} />
            <Label htmlFor="doc-age-max" className="text-text-muted">to</Label>
            <Input id="doc-age-max" type="number" min={0} max={120} className="w-20" value={d.ages?.max ?? ''} placeholder="any"
              onChange={(e) => set({ ages: e.target.value === '' && !d.ages?.min ? undefined : { min: d.ages?.min ?? 0, max: e.target.value === '' ? null : Number(e.target.value) } })} />
            <span className="text-text-muted">years. Empty means every age.</span>
          </div>
        </fieldset>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={d.acceptingNewPatients} onChange={(e) => set({ acceptingNewPatients: e.target.checked })} />
          Takes new patients
        </label>
        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium">Visit types they can be booked for</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {visitTypes.map((v) => (
              <label key={v.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={d.visitTypeIds.includes(v.id)}
                  onChange={(e) => set({ visitTypeIds: e.target.checked ? [...d.visitTypeIds, v.id] : d.visitTypeIds.filter((x) => x !== v.id) })} />
                {v.name}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Weekly hours</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={d.ownHours}
              onChange={(e) => set({ ownHours: e.target.checked, hours: e.target.checked ? (d.hours ?? clinicHours) : d.hours })} />
            Their own hours, not the clinic&apos;s
          </label>
          {d.ownHours && (
            <div className="space-y-2 rounded-md border border-border p-3">
              {DAYS.map(([day, label]) => {
                const windows = hours[day as keyof Hours] ?? [];
                return (
                  <div key={day} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="w-24 text-text-muted">{label}</span>
                    {windows.length === 0 && <span className="text-text-muted">Not working</span>}
                    {windows.map((w, i) => (
                      <span key={i} className="flex items-center gap-1">
                        <Input type="time" aria-label={`${label} from`} className="h-8 w-36" value={w.open} onChange={(e) => setDay(day, windows.map((x, j) => (j === i ? { ...x, open: e.target.value } : x)))} />
                        <span>to</span>
                        <Input type="time" aria-label={`${label} until`} className="h-8 w-36" value={w.close} onChange={(e) => setDay(day, windows.map((x, j) => (j === i ? { ...x, close: e.target.value } : x)))} />
                        <Button type="button" size="sm" variant="ghost" aria-label={`Remove these ${label} hours`} onClick={() => setDay(day, windows.filter((_, j) => j !== i))}><X /></Button>
                      </span>
                    ))}
                    <Button type="button" size="sm" variant="outline" onClick={() => setDay(day, [...windows, windows.length ? { open: '13:00', close: '17:00' } : { open: '09:00', close: '12:00' }])}><Plus /> Hours</Button>
                  </div>
                );
              })}
            </div>
          )}
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Days off</legend>
          <p className="text-xs text-text-muted">Leave, a conference, a holiday of their own. Nobody is booked with them on these days, by the assistant or at the desk.</p>
          {d.timeOff.map((t, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
              <Input type="date" aria-label="First day off" className="h-8 w-38" value={t.from} min={editing.id ? undefined : today}
                onChange={(e) => set({ timeOff: d.timeOff.map((x, j) => (j === i ? { ...x, from: e.target.value, to: x.to < e.target.value ? e.target.value : x.to } : x)) })} />
              <span>to</span>
              <Input type="date" aria-label="Last day off" className="h-8 w-38" value={t.to} min={t.from}
                onChange={(e) => set({ timeOff: d.timeOff.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)) })} />
              <Input aria-label="Note" className="h-8 flex-1" maxLength={80} value={t.note ?? ''} placeholder="Note (optional)"
                onChange={(e) => set({ timeOff: d.timeOff.map((x, j) => (j === i ? { ...x, note: e.target.value || undefined } : x)) })} />
              <Button type="button" size="sm" variant="ghost" aria-label="Remove these days off" onClick={() => set({ timeOff: d.timeOff.filter((_, j) => j !== i) })}><X /></Button>
            </div>
          ))}
          <Button type="button" size="sm" variant="outline" onClick={() => set({ timeOff: [...d.timeOff, { from: today, to: today }] })}><Plus /> Days off</Button>
        </fieldset>
      </form>
    </Panel>
  );
}
