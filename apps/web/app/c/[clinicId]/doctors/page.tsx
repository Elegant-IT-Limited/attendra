// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { DoctorInput, DoctorList, StrandedVisits } from '@attendra/api/contracts';
import { agesLine, bareName, doctorGuide, OWN_HOURS_NOTE, hadTitle, providerName, titleOf, doctorTemplate, type Gender, type Language, localDateOf, managedList, needsPhone, onList, type Provider, shownProviders, type VisitType, weeklyHoursLine, allVisitTypeIds, doesEveryVisitType } from '@attendra/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarOff, FileUp, Plus, Search, SlidersHorizontal, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useMemo, useState } from 'react';
import { ImportPanel } from '@/components/import-panel';
import { CustomFieldInputs, shownValue } from '@/components/patients/custom-fields';
import { ChipsPicker } from '@/components/ui/chips';
import { Combobox } from '@/components/ui/combobox';
import { LocalNames } from '@/components/settings/assistant';
import { ConflictsAlert } from '@/components/schedule/conflicts-alert';
import { StrandedDialog, strandedOf } from '@/components/schedule/stranded-dialog';
import { HandoverDialog } from '@/components/schedule/handover-dialog';
import { PageHeader } from '@/components/shell';
import { Badge } from '@/components/ui/badge';
import { Button, buttonStyles } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Panel } from '@/components/ui/dialog';
import { Alert, Empty, Skeleton } from '@/components/ui/feedback';
import { Input, Label, Select } from '@/components/ui/input';
import { PhoneInput } from '@/components/ui/phone-input';
import { useProblem, useToast } from '@/components/ui/toast';
import { api, ApiFailure, useClinic, useClinicConfig } from '@/lib/api';
import { dayTitle, localTime, phone, visitTypeName } from '@/lib/format';
import { useAddToList } from '@/lib/lists';
import { providerTerms, useTerms } from '@/lib/terms';
import { pageData } from '@/lib/page-data';

const DAYS = [['1', 'Monday'], ['2', 'Tuesday'], ['3', 'Wednesday'], ['4', 'Thursday'], ['5', 'Friday'], ['6', 'Saturday'], ['0', 'Sunday']] as const;
type Hours = NonNullable<Provider['hours']>;
type Draft = Omit<DoctorInput, 'gender' | 'otherPhones' | 'visitTypeIds'> & { gender: Gender | ''; ownHours: boolean; /** As typed, separated by commas. */ otherPhones: string; visitTypeIds: string[] };

// a new vet can be booked for every visit type, as the stand-in a clinic starts with could: with only the first,
// a sick visit had nobody to book it with once the stand-in stepped aside, at the desk and on calls
const blank = (visitTypes: VisitType[]): Draft => ({
  name: '', kind: 'person', gender: '', phone: '', otherPhones: '', specialty: '', categories: [], acceptingNewPatients: true, timeOff: [],
  visitTypeIds: allVisitTypeIds({ visitTypes }), ownHours: false,
});
const draftOf = (p: Provider): Draft => ({ ...p, gender: p.gender ?? '', phone: p.phone ?? '', otherPhones: (p.otherPhones ?? []).join(', '), specialty: p.specialty ?? '', ownHours: !!p.hours });

/**
 * The clinic's doctors, and rooms booked like one. The front desk and up can look (a viewer
 * sees their names on the schedule only);
 * managers add, change and remove them, set each one's weekly hours and days off, or
 * import a list. The assistant uses the list as it is now from the next thing a
 * caller asks, and every open screen shows a change without a refresh.
 */
export default function DoctorsPage() {
  const { clinicId } = useParams<{ clinicId: string }>();
  const terms = useTerms(clinicId);
  const { can, isPending } = useClinic(clinicId);
  const config = useClinicConfig(clinicId);
  const queries = useQueryClient();
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [importing, setImporting] = useState(false);
  const [text, setText] = useState('');
  const [specialty, setSpecialty] = useState('');
  const [category, setCategory] = useState('');
  const [sort, setSort] = useState<'added' | 'name' | 'specialty'>('added');
  const doctors = useQuery({ ...pageData.doctors(clinicId), enabled: can('settings:read') });
  const manager = can('settings:write');
  const refresh = () => { void queries.invalidateQueries({ queryKey: ['doctors', clinicId] }); void queries.invalidateQueries({ queryKey: ['settings', clinicId] }); void queries.invalidateQueries({ queryKey: ['schedule-conflicts', clinicId] }); };
  const tz = config.data?.timezone ?? 'UTC';
  const today = localDateOf(new Date(), tz);
  const clinicHours = config.data?.hours ?? {};

  const shown = useMemo(() => {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    // the stand-in a new clinic starts with is gone from the list once anyone else is listed
    const found = shownProviders(doctors.data?.providers ?? []).filter((p) => {
      const hay = [p.name, p.specialty ?? '', ...p.categories].join(' ').toLowerCase();
      return words.every((w) => hay.includes(w)) && (!specialty || p.specialty === specialty) && (!category || p.categories.includes(category));
    });
    if (sort === 'name') return [...found].sort((a, b) => a.name.localeCompare(b.name));
    if (sort === 'specialty') return [...found].sort((a, b) => (a.specialty || '\uffff').localeCompare(b.specialty || '\uffff') || a.name.localeCompare(b.name));
    return found;
  }, [doctors.data, text, specialty, category, sort]);
  // the clinic's own order when it keeps the lists (Settings, Fields and lists), else what the records say;
  // then any value a doctor has that is not on the list, so the filter finds every value in use
  const [specialties, categories] = useMemo(() => {
    if (!config.data) return [[], []];
    const providers = doctors.data?.providers ?? config.data.providers;
    const inUse = (name: 'specialties' | 'categories') => {
      const list = managedList({ ...config.data!, providers }, name);
      const used = providers.flatMap((p) => (name === 'specialties' ? (p.specialty ? [p.specialty] : []) : p.categories));
      return [...list, ...[...new Set(used)].filter((v) => !onList(list, v))];
    };
    return [inUse('specialties'), inUse('categories')];
  }, [config.data, doctors.data]);
  const providerFields = config.data?.providerFields ?? [];
  const filtered = !!(text || specialty || category);

  if (isPending || doctors.isPending) return <><PageHeader title={terms.title('providers')} /><Skeleton className="h-64" /></>;
  if (doctors.isError || !doctors.data) return <><PageHeader title={terms.title('providers')} /><Alert tone="danger">The list of {terms.providers} did not load. Refresh to try again.</Alert></>;
  const { visitTypes, noProvider } = doctors.data;
  const visitName = (id: string) => visitTypeName(visitTypes.find((v) => v.id === id)?.name ?? id);

  return (
    <>
      <PageHeader title={terms.title('providers')} description={terms.patient === 'pet' ? 'Who can be booked, the animals and services they see, their weekly hours and days off. The assistant uses this list from the next thing a caller asks.' : 'Who can be booked, what they see people for, the ages they see, their weekly hours and days off. The assistant uses this list from the next thing a caller asks.'}
        actions={manager && (
          <>
            <Link href={`/c/${clinicId}/settings/fields?tab=providers`} className={buttonStyles({ variant: 'ghost' })}><SlidersHorizontal /> Manage fields and lists</Link>
            <Button variant="outline" onClick={() => setImporting(true)}><FileUp /> Import</Button>
            <Button onClick={() => setEditing({ id: null, draft: blank(visitTypes) })}><Plus /> Add {terms.provider}</Button>
          </>
        )} />
      <ConflictsAlert clinicId={clinicId} className="mb-4" />
      {/* the server's words, the same as Settings shows: a visit type nobody does can't be booked */}
      {noProvider.length > 0 && <div className="mb-4 space-y-2" data-testid="no-provider-warnings">{noProvider.map((w) => <Alert key={w.visitTypeId} tone="warn">{w.message}</Alert>)}</div>}
      {/* the same filter bar as Pets and Requests: a card, search first, then the dropdowns */}
      <Card className="mb-4"><CardContent className="py-4">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter the list">
        <div className="relative w-full max-w-md">
          <Label htmlFor="doctor-search" className="sr-only">Find a {terms.provider}</Label>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-muted" aria-hidden />
          <Input id="doctor-search" type="search" className="pl-9" autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} placeholder={terms.patient === 'pet' ? 'Name, specialty, animal or service' : 'Name, specialty or reason'} />
        </div>
        <Label htmlFor="doctor-specialty" className="sr-only">Specialty</Label>
        <Select id="doctor-specialty" className="w-48" value={specialty} onChange={(e) => setSpecialty(e.target.value)}>
          <option value="">{providerTerms(terms.patient === 'pet').anySpecialty}</option>
          {specialties.map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>
        <Label htmlFor="doctor-category" className="sr-only">{providerTerms(terms.patient === 'pet').sees}</Label>
        <Select id="doctor-category" className="w-48" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">{providerTerms(terms.patient === 'pet').anySees}</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
        <Label htmlFor="doctor-sort" className="sr-only">Sort</Label>
        <Select id="doctor-sort" className="w-52" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          <option value="added">In the order added</option>
          <option value="name">By name</option>
          <option value="specialty">By specialty</option>
        </Select>
        {filtered && <Button variant="ghost" size="sm" onClick={() => { setText(''); setSpecialty(''); setCategory(''); }}><X /> Clear</Button>}
      </div>
      </CardContent></Card>
      {!shown.length ? <Card><Empty title={filtered ? `No ${terms.provider} matches` : `No ${terms.providers} yet`}>{filtered ? 'Try another word, specialty or filter.' : `Add the first ${terms.provider}, or import a list.`}</Empty></Card> : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((p) => {
            const away = p.timeOff.filter((t) => t.to >= today).sort((a, b) => a.from.localeCompare(b.from));
            return (
              <Card key={p.id} className="flex flex-col" data-testid="doctor">
                <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{providerName(p)}</p>
                    {p.placeholder && <p className="mt-1"><Badge tone="warn">A stand-in: offered only until you add your own</Badge></p>}
                    {config.data && needsPhone(config.data, p) && <p className="mt-1"><Badge tone="warn">Add a phone number</Badge></p>}
                    {/* the specialty alone: sex beside it read as part of it ("Breath Issues, Female"); it stays in the vet's details */}
                    <p className="text-sm text-text-muted" data-testid="doctor-subtitle">{p.specialty || (p.kind === 'room' ? 'A room' : 'No specialty set')}</p>
                  </div>
                  {p.acceptingNewPatients ? <Badge tone="ok">Takes new {terms.patients}</Badge> : <Badge>No new {terms.patients}</Badge>}
                </div>
                <dl className="grid flex-1 grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-5 py-4 text-sm">
                  {terms.patient !== 'pet' && <><dt className="text-text-muted">Sees</dt><dd>{agesLine(p).replace(/^./, (c) => c.toUpperCase())}</dd></>}
                  {p.phone && <><dt className="text-text-muted">Phone</dt><dd className="tabular-nums" data-testid="doctor-phone">{[p.phone, ...(p.otherPhones ?? [])].map(phone).join(', ')}</dd></>}
                  {!!p.credentials?.length && <><dt className="text-text-muted">Qualified</dt><dd>{p.credentials.join(', ')}</dd></>}
                  {p.categories.length > 0 && <><dt className="text-text-muted">{providerTerms(terms.patient === 'pet').sees}</dt><dd className="flex flex-wrap content-start items-start gap-1">{p.categories.map((c) => <Badge key={c} tone="accent">{c}</Badge>)}</dd></>}
                  {providerFields.filter((f) => p.custom?.[f.id]).map((f) => <div key={f.id} className="contents"><dt className="text-text-muted">{f.label}</dt><dd>{shownValue(f, p.custom?.[f.id])}</dd></div>)}
                  <dt className="text-text-muted">Visit types they do</dt><dd>{doesEveryVisitType(p, { visitTypes }) ? 'All visit types' : p.visitTypeIds.map(visitName).join(', ')}</dd>
                  <dt className="text-text-muted">Hours</dt><dd className="space-y-0.5">{weeklyHoursLine(p.hours ?? clinicHours, localTime).split('; ').map((line) => <span key={line} className="block">{line}</span>)}{!p.hours && <span className="block text-text-muted">The clinic&apos;s hours</span>}</dd>
                  {away.length > 0 && <><dt className="text-text-muted">Away</dt><dd className="space-y-0.5">{away.slice(0, 3).map((t, i) => <span key={`${t.from}-${i}`} className="flex items-center gap-1"><CalendarOff className="size-3.5 text-text-muted" aria-hidden />{t.from === t.to ? dayTitle(t.from) : `${dayTitle(t.from)} to ${dayTitle(t.to)}`}{t.start && t.end ? `, ${localTime(t.start)} to ${localTime(t.end)}` : ''}{t.note ? `, ${t.note}` : ''}</span>)}</dd></>}
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
        <DoctorPanel clinicId={clinicId} editing={editing} visitTypes={visitTypes} clinicHours={clinicHours} languages={config.data?.languages ?? ['en']} today={today}
          onClose={() => setEditing(null)} onSaved={refresh} />
      )}
      <ImportPanel open={importing} onOpenChange={setImporting} title={`Import ${terms.providers}`} what={terms.providers} endpoint={`/clinics/${clinicId}/doctors/import`}
        template={{ name: `attendra-${terms.providers}-template.csv`, csv: doctorTemplate(config.data ?? { visitTypes }) }} guide={doctorGuide(config.data ?? { visitTypes })} onImported={refresh} />
    </>
  );
}

function DoctorPanel({ clinicId, editing, visitTypes, clinicHours, languages, today, onClose, onSaved }: {
  clinicId: string; editing: { id: string | null; draft: Draft }; visitTypes: VisitType[]; clinicHours: Hours; languages: Language[]; today: string;
  onClose: () => void; onSaved: () => void;
}) {
  const terms = useTerms(clinicId);
  const pets = terms.patient === 'pet';
  const [d, setD] = useState<Draft>(editing.draft);
  const [categories, setCategories] = useState<string[]>(editing.draft.categories);
  const [custom, setCustom] = useState<Record<string, string>>(editing.draft.custom ?? {});
  const config = useClinicConfig(clinicId);
  const lists = config.data ? { specialties: managedList(config.data, 'specialties'), categories: managedList(config.data, 'categories') } : { specialties: [], categories: [] };
  const providerFields = config.data?.providerFields ?? [];
  const [credentials, setCredentials] = useState((editing.draft.credentials ?? []).join(', '));
  // owners and managers add to the lists from here; a value not on them is refused under its field
  const addSpecialty = useAddToList(clinicId, 'specialties');
  const addCategory = useAddToList(clinicId, 'categories');
  const [fieldErrors, setFieldErrors] = useState<{ specialty?: string; categories?: string; phone?: string; otherPhones?: string }>({});
  const FIELDS = ['specialty', 'categories', 'phone', 'otherPhones'] as const;
  // what did not work opens in a dialog, wherever the page is scrolled
  const showProblem = useProblem();
  const setProblem = (message: string | null) => { if (message) showProblem({ title: 'Not saved', message }); };
  const [confirmDelete, setConfirmDelete] = useState(false);
  // a vet with visits still to come: their visits go to other vets first (note 32)
  const [handover, setHandover] = useState(false);
  const toast = useToast();
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const hours: Hours = d.hours ?? {};
  const failed = (e: unknown) => {
    // a problem with the specialty or the categories goes under that field; anything else in the dialog
    const issues = e instanceof ApiFailure ? e.body.issues ?? [] : [];
    const own = (path: string) => issues.find((i) => i.path === path)?.message;
    setFieldErrors(Object.fromEntries(FIELDS.map((f) => [f, own(f)])));
    const rest = issues.filter((i) => !(FIELDS as readonly string[]).includes(i.path));
    if (issues.length && !rest.length) return;
    setProblem(e instanceof ApiFailure
      ? (rest.map((i) => i.message).join('. ') || e.body.message || 'That did not save.')
      : 'That did not save. Check your connection and try again.');
  };

  // hours or days off that would leave booked visits outside any bookable time: the "move or keep" list, and what was being saved
  const [stranded, setStranded] = useState<{ visits: StrandedVisits; body: DoctorInput } | null>(null);
  const save = useMutation({
    // with keep, the visits the server listed stay where they are (audited there)
    mutationFn: ({ body, keep }: { body: DoctorInput; keep?: boolean }) => api<DoctorList>(`/clinics/${clinicId}/doctors${editing.id ? `/${editing.id}${keep ? '?keepStranded=true' : ''}` : ''}`, { method: editing.id ? 'PUT' : 'POST', body: JSON.stringify(body) }),
    onSuccess: () => { setStranded(null); onSaved(); toast({ tone: 'success', message: editing.id ? 'Saved. The assistant uses it from the next request.' : 'Added. The assistant can book them from the next request.' }); onClose(); },
    onError: (e, { body }) => {
      const visits = strandedOf(e);
      if (visits) { setStranded({ visits, body }); return; }
      setStranded(null);
      failed(e);
    },
  });
  const remove = useMutation({
    mutationFn: () => api<DoctorList>(`/clinics/${clinicId}/doctors/${editing.id}`, { method: 'DELETE' }),
    onSuccess: () => { onSaved(); toast({ tone: 'success', message: 'Removed.' }); setHandover(false); onClose(); },
    onError: (e) => {
      if (e instanceof ApiFailure && e.status === 409 && e.body.error === 'has_upcoming_visits') { setConfirmDelete(false); setHandover(true); return; }
      failed(e);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const { ownHours, gender, otherPhones, ...rest } = d;
    if (!gender) { setProblem(`Choose their gender, so callers who ask for a female or a male ${terms.provider} are offered the right one.`); return; }
    if (!d.visitTypeIds.length) { setProblem(`Choose at least one visit type they do. Callers are offered a ${terms.provider} only for the visit types ticked here.`); return; }
    save.mutate({ body: {
      ...rest,
      gender,
      name: d.name.trim(),
      phone: d.phone?.trim() || undefined,
      otherPhones: otherPhones.split(/[,;]/).map((x) => x.trim()).filter(Boolean),
      specialty: d.specialty?.trim() || undefined,
      categories,
      // the clinic's own fields, all of them, so a required one left empty is caught
      ...(providerFields.length ? { custom: Object.fromEntries(providerFields.map((f) => [f.id, custom[f.id] ?? ''])) } : {}),
      credentials: credentials.split(/[,;]/).map((c) => c.trim()).filter(Boolean),
      hours: ownHours ? Object.fromEntries(Object.entries(hours).filter(([, w]) => w && w.length)) : undefined,
      timeOff: d.timeOff.filter((t) => t.from && t.to),
    } });
  };
  const setDay = (day: string, windows: { open: string; close: string }[]) => set({ hours: { ...hours, [day]: windows } });

  return (
    <Panel open onOpenChange={(o) => { if (!o) onClose(); }} side="right" title={editing.id ? `Edit ${providerName({ ...editing.draft, gender: editing.draft.gender || undefined })}` : `Add ${terms.provider}`}
      description="Saved changes reach the assistant on the next thing a caller asks."
      footer={(
        <>
          {editing.id && (confirmDelete
            ? <><span className="mr-auto self-center text-sm">Remove {editing.draft.name}?</span><Button variant="ghost" onClick={() => setConfirmDelete(false)}>No</Button><Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>Remove</Button></>
            : <Button variant="ghost" className="mr-auto" onClick={() => setConfirmDelete(true)}><Trash2 /> Remove</Button>)}
          {!confirmDelete && <><Button variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" form="doctor-form" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button></>}
        </>
      )}>
      {config.data && (
        <StrandedDialog clinicId={clinicId} clinic={config.data} stranded={stranded?.visits ?? null} pending={save.isPending}
          onKeep={() => stranded && save.mutate({ body: stranded.body, keep: true })} onClose={() => setStranded(null)} />
      )}
      {editing.id && config.data && (
        <HandoverDialog clinicId={clinicId} clinic={config.data} providerId={editing.id} open={handover} onClose={() => setHandover(false)}
          onRemove={() => remove.mutate()} removing={remove.isPending} />
      )}
      <form id="doctor-form" onSubmit={submit} className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <div className="space-y-1.5"><Label htmlFor="doc-name">Name</Label>
            <Input id="doc-name" required minLength={2} maxLength={80} autoComplete="off" value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="Jane Example" aria-describedby="doc-name-hint" />
            <p id="doc-name-hint" className="text-xs text-text-muted">
              {d.kind === 'room' ? 'As callers hear it, e.g. "the X-ray room".' : hadTitle(d.name) ? `We add ${titleOf(d) === 'dr' ? 'Dr.' : 'no title'} for you: saved as "${bareName(d.name)}".` : `We add Dr. for you: callers hear "${providerName({ ...d, gender: d.gender || undefined })}".`}
            </p>
          </div>
          <div className="space-y-1.5"><Label htmlFor="doc-kind">Is a</Label>
            <Select id="doc-kind" value={d.kind} onChange={(e) => set({ kind: e.target.value as 'person' | 'room' })}><option value="person">Person</option><option value="room">Room</option></Select>
          </div>
        </div>
        {d.kind === 'person' && (
          <div className="space-y-1.5">
            <Label htmlFor="doc-title">Title</Label>
            <Select id="doc-title" className="sm:w-64" value={d.title ?? 'dr'} onChange={(e) => set({ title: e.target.value as 'dr' | 'none' })} aria-describedby="doc-title-hint">
              <option value="dr">Dr.</option>
              <option value="none">None (technicians, groomers, other team)</option>
            </Select>
            <p id="doc-title-hint" className="text-xs text-text-muted">How the assistant, the schedule and texts say their name. In Spanish, Dra. for a woman.</p>
          </div>
        )}
        {languages.every((l) => l === 'en') ? null : (
          <div className="space-y-3">
            <LocalNames thing={d} languages={languages} what={terms.title('provider')} onChange={(names) => set({ names })} />
            <p className="text-xs text-text-muted">How the assistant says their name to a caller in that language. Empty means it uses the name above.</p>
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="doc-gender">Gender</Label>
          <Select id="doc-gender" required value={d.gender} onChange={(e) => set({ gender: e.target.value as Gender | '' })}>
            <option value="" disabled>Choose</option>
            <option value="female">Female</option><option value="male">Male</option><option value="other">Other</option><option value="undisclosed">Prefers not to say</option>
          </Select>
          <p className="text-xs text-text-muted">A caller can ask for a female or a male {terms.provider}.</p>
        </div>
        {d.kind === 'person' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="doc-phone">Phone (private)</Label>
              <PhoneInput id="doc-phone" autoComplete="off" value={d.phone ?? ''} placeholder="(555) 555-0123" aria-invalid={!!fieldErrors.phone || undefined} aria-describedby={fieldErrors.phone ? 'doc-phone-error' : 'doc-phone-hint'}
                onValue={(phone) => { set({ phone }); setFieldErrors((f) => ({ ...f, phone: undefined })); }} />
              {fieldErrors.phone ? <p id="doc-phone-error" className="text-xs text-danger">{fieldErrors.phone}</p>
                : <p id="doc-phone-hint" className="text-xs text-text-muted">Private: for telling {pets ? 'vets' : 'doctors'} apart, never told to callers.</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="doc-other-phones">Other numbers</Label>
              <PhoneInput id="doc-other-phones" mode="several" autoComplete="off" value={d.otherPhones} placeholder="Separated by commas" aria-invalid={!!fieldErrors.otherPhones || undefined} aria-describedby={fieldErrors.otherPhones ? 'doc-other-phones-error' : undefined}
                onValue={(otherPhones) => { set({ otherPhones }); setFieldErrors((f) => ({ ...f, otherPhones: undefined })); }} />
              {fieldErrors.otherPhones && <p id="doc-other-phones-error" className="text-xs text-danger">{fieldErrors.otherPhones}</p>}
            </div>
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="doc-specialty">Specialty</Label>
          <Combobox id="doc-specialty" label="Specialty" value={d.specialty ?? ''} options={lists.specialties} onChange={(specialty) => { set({ specialty }); setFieldErrors((f) => ({ ...f, specialty: undefined })); }}
            placeholder="Pick from your list" onAdd={addSpecialty} addLabel="Add a specialty" error={fieldErrors.specialty} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="doc-categories">{providerTerms(pets).sees}</Label>
          <ChipsPicker id="doc-categories" label={providerTerms(pets).sees} values={categories} suggestions={lists.categories} onChange={(v) => { setCategories(v); setFieldErrors((f) => ({ ...f, categories: undefined })); }}
            placeholder="Type to find one on your list" onAdd={addCategory} addLabel="Add one to the list" error={fieldErrors.categories} />
          <p className="text-xs text-text-muted">Picked from your list. The assistant tells callers, so they pick the right {terms.provider}. Rename or order the list under Settings, Fields and lists.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="doc-credentials">Qualifications and certifications</Label>
          <Input id="doc-credentials" maxLength={500} autoComplete="off" aria-describedby="doc-credentials-hint" value={credentials} onChange={(e) => setCredentials(e.target.value)} placeholder={pets ? 'e.g. DVM, Fear Free Certified' : 'e.g. MD, Board-certified in family medicine'} />
          <p id="doc-credentials-hint" className="text-xs text-text-muted">Separated by commas, up to 8, each 2 to 60 characters. Shown on this page, and the assistant mentions them when a caller asks.</p>
        </div>
        {providerFields.length > 0 && (
          <fieldset className="space-y-3 rounded-lg border border-border p-4">
            <legend className="px-1 text-sm font-medium">More details</legend>
            <CustomFieldInputs idPrefix="doc-cf" fields={providerFields} values={custom} onChange={(id, v) => setCustom((c) => ({ ...c, [id]: v }))} />
          </fieldset>
        )}
        {!pets && <fieldset className="space-y-1.5">
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
        </fieldset>}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={d.acceptingNewPatients} onChange={(e) => set({ acceptingNewPatients: e.target.checked })} />
          Takes new {terms.patients}
        </label>
        <fieldset className="space-y-1.5" aria-describedby="doc-visit-types-hint">
          <legend className="text-sm font-medium">Visit types they do</legend>
          <p id="doc-visit-types-hint" className="text-xs text-text-muted">Callers and the desk can book them only for these. A visit type ticked for nobody can&apos;t be booked.</p>
          {/* one click for everything, and one click back to choosing */}
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={doesEveryVisitType(d, { visitTypes })}
              onChange={(e) => set({ visitTypeIds: e.target.checked ? allVisitTypeIds({ visitTypes }) : [] })} />
            All visit types
          </label>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {visitTypes.map((v) => (
              <label key={v.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={d.visitTypeIds.includes(v.id)}
                  onChange={(e) => set({ visitTypeIds: e.target.checked ? [...d.visitTypeIds, v.id] : d.visitTypeIds.filter((x) => x !== v.id) })} />
                {visitTypeName(v.name)}
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
          {d.ownHours && <p className="text-xs text-text-muted" data-testid="own-hours-note">{OWN_HOURS_NOTE.en}</p>}
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
          <p className="text-xs text-text-muted">Leave, a conference, a holiday of their own. Nobody is booked with them on these days, by the assistant or at the desk. Away for part of a day: no times are offered between these, visits outside them are unchanged.</p>
          <Button type="button" size="sm" variant="outline" onClick={() => set({ timeOff: [{ from: today, to: today }, ...d.timeOff] })}><Plus /> Days off</Button>
          {d.timeOff.map((t, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
              <Input type="date" aria-label={t.start ? 'Day' : 'First day off'} className="h-8 w-38" value={t.from} min={editing.id && t.from < today ? undefined : today}
                onChange={(e) => set({ timeOff: d.timeOff.map((x, j) => (j === i ? { ...x, from: e.target.value, to: x.start || x.to < e.target.value ? e.target.value : x.to } : x)) })} />
              {t.start ? (
                <>
                  <span>from</span>
                  <Input type="time" aria-label="Away from" className="h-8 w-28" value={t.start} onChange={(e) => set({ timeOff: d.timeOff.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)) })} />
                  <span>to</span>
                  <Input type="time" aria-label="Back at" className="h-8 w-28" value={t.end ?? ''} onChange={(e) => set({ timeOff: d.timeOff.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)) })} />
                </>
              ) : (
                <>
                  <span>to</span>
                  <Input type="date" aria-label="Last day off" className="h-8 w-38" value={t.to} min={t.from}
                    onChange={(e) => set({ timeOff: d.timeOff.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)) })} />
                </>
              )}
              <label className="flex items-center gap-1.5 text-xs">
                <input type="checkbox" className="size-4 accent-primary" checked={!!t.start}
                  onChange={(e) => set({ timeOff: d.timeOff.map((x, j) => (j === i ? (e.target.checked ? { ...x, to: x.from, start: '12:00', end: '17:00' } : { from: x.from, to: x.to, note: x.note }) : x)) })} />
                Part of the day
              </label>
              <Input aria-label="Note" className="h-8 flex-1" maxLength={80} autoComplete="off" value={t.note ?? ''} placeholder="Note (optional)"
                onChange={(e) => set({ timeOff: d.timeOff.map((x, j) => (j === i ? { ...x, note: e.target.value || undefined } : x)) })} />
              <Button type="button" size="sm" variant="ghost" aria-label="Remove these days off" onClick={() => set({ timeOff: d.timeOff.filter((_, j) => j !== i) })}><X /></Button>
            </div>
          ))}
        </fieldset>
      </form>
    </Panel>
  );
}
