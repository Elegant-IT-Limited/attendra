// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { asE164, RETENTION_CHOICES, callingCode, defaultTalkStyle, hasPreview, PREVIEW_VOICES, type TalkStyle, type ClinicConfig, type Terms, clinicWarnings, countryCopy, emergencyNumberFor, voiceLabel } from '@attendra/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AssistantSection, LocalNames } from '@/components/settings/assistant';
import { BookingRulesSection } from '@/components/settings/booking-rules';
import { EmptyNote, Field, Item, Section } from '@/components/settings/section';
import { SettingsNav } from '@/components/settings/settings-nav';
import { SpecialDaysEditor } from '@/components/settings/special-days';
import { moved, Sortable } from '@/components/ui/sortable';
import { TimeZonePicker } from '@/components/settings/time-zone-picker';
import { VoicePreview } from '@/components/settings/voice-preview';
import { ConflictsAlert } from '@/components/schedule/conflicts-alert';
import { Switch } from '@/components/ui/controls';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/shell';
import { Button, buttonStyles } from '@/components/ui/button';
import { type Conflict, SettingsConflict } from '@/components/settings/settings-conflict';
import { Alert, Skeleton } from '@/components/ui/feedback';
import { Input, Select, Textarea } from '@/components/ui/input';
import { useProblem, useToast } from '@/components/ui/toast';
import { api, ApiFailure, apiTagged, useClinic } from '@/lib/api';
import { clinicTime, DAYS, dayTitle, phone } from '@/lib/format';
import { useActiveSection } from '@/lib/scroll-spy';
import { cn } from '@/lib/utils';
import { useTerms } from '@/lib/terms';

type Day = '0' | '1' | '2' | '3' | '4' | '5' | '6';
type ListKey = 'routing' | 'faqs' | 'offers' | 'requestTopics' | 'customFields' | 'vipCallers' | 'menuLinks' | 'visitTypes';
type T = Terms & { title: (t: keyof Terms) => string };

/** The parts of this page, in order, for its own menu. */
const PARTS: { id: string; label: (t: T) => string }[] = [
  { id: 'greeting-voice', label: () => 'Greeting and voice' },
  { id: 'assistant', label: () => 'Assistant and languages' },
  { id: 'hours', label: () => 'Opening hours' },
  { id: 'holidays', label: () => 'Holidays and special days' },
  { id: 'emergency', label: () => 'Emergency hospitals' },
  { id: 'visits', label: () => 'Visit types' },
  { id: 'booking', label: () => 'Booking rules' },
  { id: 'transfers', label: () => 'Transfers' },
  { id: 'vip', label: () => 'VIP callers' },
  { id: 'answers', label: () => 'Common questions' },
  { id: 'offers', label: () => 'Offers' },
  { id: 'fields', label: () => 'Fields and lists' },
  { id: 'links', label: () => 'Menu links' },
  { id: 'records', label: () => 'Call records' },
  { id: 'numbers', label: () => 'Phone numbers' },
];

/** Where a save problem is, in the page's words rather than the setting's path. */
function issueLabel(path: string) {
  const top = path.split('.')[0] ?? '';
  const names: Record<string, string> = {
    greeting: 'Greeting', name: 'Clinic name', routing: 'Transfers', visitTypes: 'Visit types', faqs: 'Common questions', offers: 'Offers',
    requestTopics: 'Kinds of request', customFields: 'Fields', vipCallers: 'VIP callers', menuLinks: 'Menu links', emergencyHospital: 'Emergency hospitals', moreEmergencyHospitals: 'Emergency hospitals',
    hours: 'Opening hours', holidays: 'Holidays', specialDays: 'Special days', assistantName: 'Assistant name', emergencyNumber: 'Emergency number', languages: 'Languages', retentionDays: 'Call records',
    address: 'Address', website: 'Website', industry: 'Kind of practice', timezone: 'Time zone', voice: 'Voice', primaryLanguage: 'Languages', afterHours: 'After hours',
    averageVisitValue: 'Average visit value', booking: 'Booking rules', talk: 'How the assistant talks', greetings: 'Greetings', texting: 'Texting', emergencyTransferEnabled: 'Emergency hospitals', recording: 'Call records', phoneNumbers: 'Phone numbers', providers: 'Doctors and veterinarians',
    emergencyReview: 'Emergency list review',
  };
  return names[top] ?? (top || 'Settings');
}
/** The clinic's talk settings with defaults, so one change keeps the other two. */
const talkOf = (c: ClinicConfig): TalkStyle => ({ pace: c.talk?.pace ?? 'normal', style: c.talk?.style ?? defaultTalkStyle(c.industry), acknowledgements: c.talk?.acknowledgements ?? true });

/** A row nobody has typed in yet: the button that made it points to it again instead of adding another, and Save leaves it out. */
const BLANK = {
  named: (x: { name: string }) => !x.name.trim(),
  hospital: (h: { name: string; phone: string; address?: string }) => !h.name.trim() && !h.phone.replace(/\D/g, '') && !h.address?.trim(),
  /** Empty, or only the country code the new row started with. A SIP address (sip:frontdesk@pbx…) is never blank. */
  number: (n: string, c: { phoneNumbers: string[] }) => {
    if (/^sips?:\S/i.test(n.trim())) return false;
    const d = n.replace(/\D/g, '');
    return !d || d === (callingCode(c.phoneNumbers[0] ?? '') ?? '');
  },
};

/** The settings without rows left empty, so a forgotten new row never blocks a save. */
function withoutBlankRows(c: ClinicConfig): ClinicConfig {
  const hospitals = [...(c.emergencyHospital ? [c.emergencyHospital] : []), ...(c.moreEmergencyHospitals ?? [])].filter((h) => !BLANK.hospital(h));
  return {
    ...c,
    emergencyHospital: hospitals[0], moreEmergencyHospitals: hospitals.length > 1 ? hospitals.slice(1) : undefined,
    visitTypes: c.visitTypes.filter((v) => !BLANK.named(v)),
    routing: c.routing.filter((r) => !BLANK.number(r.uri, c)),
    vipCallers: c.vipCallers?.filter((v) => v.name.trim() || !BLANK.number(v.phone, c)),
    faqs: c.faqs.filter((f) => f.question.trim() || f.answer.trim()),
    offers: c.offers?.filter((o) => o.title.trim() || o.details.trim()),
    requestTopics: c.requestTopics?.filter((t) => !BLANK.named(t)),
    customFields: c.customFields?.filter((f) => f.label.trim()),
    menuLinks: c.menuLinks?.filter((l) => l.label.trim() || !/^(https?:\/\/)?$/.test(l.url.trim())),
    phoneNumbers: c.phoneNumbers.filter((n) => n.trim()),
  };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'new';
const newId = (prefix: string, name: string) => `${prefix}_${slug(name)}_${Math.random().toString(36).slice(2, 6)}`;

export default function Settings() {
  const { clinicId } = useParams<{ clinicId: string }>();
  const terms = useTerms(clinicId);
  const { can, clinic } = useClinic(clinicId);
  // the assistant's own numbers, to tell them from the clinic's line in the list of numbers
  const meta = useQuery({ queryKey: ['settings-meta', clinicId], queryFn: () => api<{ assistantNumbers?: string[] }>(`/clinics/${clinicId}/settings/meta`) });
  const assistantNumbers = new Set(meta.data?.assistantNumbers ?? []);
  const queries = useQueryClient();
  const toast = useToast();
  const problem = useProblem();
  // its own copy with the version it was read at, read fresh each time the page opens and
  // never swapped under a draft: a save is refused if someone else saved since
  const loaded = useQuery({ queryKey: ['settings-versioned', clinicId], queryFn: () => apiTagged<ClinicConfig>(`/clinics/${clinicId}/settings`), gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false });
  const saved = { ...loaded, data: loaded.data?.body };
  const [draft, setDraft] = useState<ClinicConfig | null>(null);
  const [conflict, setConflict] = useState<Conflict<ClinicConfig> | null>(null);
  const [newHoliday, setNewHoliday] = useState('');
  useEffect(() => { if (saved.data && !draft) setDraft(saved.data); }, [saved.data, draft]);
  const pet = draft?.industry === 'vet';
  const parts = PARTS.filter((part) => part.id !== 'emergency' || pet || !!draft?.emergencyHospital);
  // the section being read, highlighted in the menu as the page scrolls
  const reading = useActiveSection(draft ? parts.map((p) => p.id) : []);
  const keep = (config: ClinicConfig, etag: string | null) => {
    queries.setQueryData(['settings-versioned', clinicId], { body: config, etag });
    queries.setQueryData(['settings', clinicId], config);
  };
  // a new row goes to the top of its list, under the button that made it: bring it into view and put the cursor in its first field
  const [added, setAdded] = useState<string | null>(null);
  useEffect(() => {
    if (!added) return;
    const el = document.getElementById(added);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el?.querySelector<HTMLInputElement>('input, select, textarea')?.focus({ preventScroll: true });
    // a brief outline, so the eye finds the row the button pointed to
    el?.classList.add('ring-2', 'ring-primary');
    // not cleared when `added` resets below: the outline must still come off
    if (el) setTimeout(() => el.classList.remove('ring-2', 'ring-primary'), 1200);
    setAdded(null);
  }, [added, draft]);
  /** One empty row at a time: with an empty one already there, the button takes you to it instead of adding another. */
  const addOrFocus = <T,>(list: T[], blank: (x: T) => boolean, idOf: (x: T, i: number) => string, add: () => void) => {
    const i = list.findIndex(blank);
    if (i >= 0) setAdded(idOf(list[i]!, i));
    else add();
  };

  const save = useMutation({
    mutationFn: (config: ClinicConfig) => apiTagged<ClinicConfig>(`/clinics/${clinicId}/settings`, {
      method: 'PUT', body: JSON.stringify(config), headers: loaded.data?.etag ? { 'if-match': loaded.data.etag } : {},
    }),
    onMutate: () => setConflict(null),
    onSuccess: ({ body: config, etag }) => {
      keep(config, etag);
      void queries.invalidateQueries({ queryKey: ['schedule-conflicts', clinicId] });
      // the clinic's name and time zone also come with who you are, for every other page
      void queries.invalidateQueries({ queryKey: ['me'] });
      setDraft(config);
      toast({ tone: 'success', message: 'Saved. The next call uses these settings.' });
    },
    onError: (e) => {
      if (!(e instanceof ApiFailure)) { problem({ title: 'Not saved', message: 'The settings did not reach the server. Check your connection and press Save changes again.' }); return; }
      if (e.status === 409 && e.body.error === 'settings_changed') {
        const b = e.body as unknown as { current: ClinicConfig; version: number; updatedAt: string | null; updatedBy: { name: string } | null };
        setConflict({ theirs: b.current, version: b.version, updatedAt: b.updatedAt, updatedBy: b.updatedBy });
        return;
      }
      const issues = e.body.issues ?? [{ path: '', message: e.message }];
      problem({ title: 'Not saved. Fix these first', items: issues.map((i) => (i.path ? `${issueLabel(i.path)}: ${i.message}` : i.message)) });
    },
  });

  if (saved.isError) return <><PageHeader title="Settings" /><Alert tone="danger">The clinic settings did not load. Refresh the page; if it keeps failing, check that the API is running.</Alert></>;
  if (!draft) return <><PageHeader title="Settings" /><Skeleton className="h-96" /></>;
  const c = draft;
  const set = (patch: Partial<ClinicConfig>) => setDraft({ ...c, ...patch });
  const dirty = JSON.stringify(c) !== JSON.stringify(saved.data);
  const writable = can('settings:write');

  const windows = (d: Day) => c.hours[d] ?? [];
  const setWindows = (d: Day, w: { open: string; close: string }[]) => set({ hours: { ...c.hours, [d]: w } });

  // the first hospital is the clinic's first choice; the rest, in order, its next ones
  const hospitals = [...(c.emergencyHospital ? [c.emergencyHospital] : []), ...(c.moreEmergencyHospitals ?? [])];
  const setHospitals = (list: typeof hospitals) => set({ emergencyHospital: list[0], moreEmergencyHospitals: list.length > 1 ? list.slice(1) : undefined });
  const upd = <K extends ListKey>(key: K, i: number, patch: Partial<NonNullable<ClinicConfig[K]>[number]>) =>
    set({ [key]: ((c[key] ?? []) as object[]).map((x, j) => (j === i ? { ...x, ...patch } : x)) } as Partial<ClinicConfig>);
  const remove = <K extends ListKey>(key: K, i: number) => set({ [key]: ((c[key] ?? []) as object[]).filter((_, j) => j !== i) } as Partial<ClinicConfig>);
  const visit = (i: number, patch: Partial<ClinicConfig['visitTypes'][number]>) => upd('visitTypes', i, patch);
  const num = (v: string) => (v === '' ? undefined : Number(v));
  // shown as a plain phone number; stored as the tel: address a transfer dials (a sip: address is kept as typed)
  const shownUri = (uri: string) => (uri.startsWith('tel:') ? uri.slice(4) : uri);
  const storedUri = (v: string) => (/^sips?:/i.test(v.trim()) ? v.trim() : `tel:${v.replace(/[^\d+]/g, '')}`);

  return (
    <>
      <PageHeader title="Settings" description="What the assistant says, when the clinic is open, and what it can book. Changes apply to the next call." />
      <SettingsNav clinicId={clinicId} />
      {!writable && <Alert className="mb-6">You can read these settings. A practice manager or owner can change them.</Alert>}
      {conflict && saved.data && (
        <SettingsConflict base={saved.data} mine={c} conflict={conflict} label={issueLabel} timeLabel={(iso) => clinicTime(iso, c.timezone)}
          onResolved={(next) => { keep(conflict.theirs, `"v${conflict.version}"`); setDraft(next); setConflict(null); }} />
      )}
      <div className="lg:grid lg:grid-cols-[11rem_minmax(0,1fr)] lg:gap-8">
        <nav aria-label="On this page" className="hidden lg:block">
          <ul className="sticky top-6 space-y-0.5 text-sm">
            {parts.map((part) => (
              <li key={part.id}>
                <a href={`#${part.id}`} aria-current={reading === part.id ? 'location' : undefined}
                  className={cn('focus-ring block rounded-md border-l-2 px-2.5 py-1.5 transition-colors', reading === part.id
                    ? 'border-primary bg-primary-soft font-medium text-primary' : 'border-transparent text-text-muted hover:bg-surface-sunken hover:text-text')}>
                  {part.label(terms)}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      <fieldset disabled={!writable || save.isPending} className="min-w-0 space-y-6 pb-24">
        <Section id="greeting-voice" title="Greeting and voice" description="Callers must hear that they are talking to an AI assistant. The greeting cannot be saved without it.">
          <Field label="Clinic name" htmlFor="name"><Input id="name" value={c.name} onChange={(e) => set({ name: e.target.value })} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Address" htmlFor="address" hint="Given to callers who ask where you are."><Input id="address" maxLength={200} value={c.address ?? ''} placeholder="e.g. 400 Main Street, Denver" onChange={(e) => set({ address: e.target.value || undefined })} /></Field>
            <Field label="Website" htmlFor="website" hint="Optional."><Input id="website" type="url" maxLength={200} value={c.website ?? ''} placeholder="https://" onChange={(e) => set({ website: e.target.value && e.target.value !== 'https://' ? e.target.value : undefined })} /></Field>
          </div>
          <Field label="Greeting" htmlFor="greeting" hint={`${c.greeting.length}/400. Mention "AI assistant", "virtual receptionist" or similar.`}>
            <Textarea id="greeting" value={c.greeting} maxLength={400} onChange={(e) => set({ greeting: e.target.value })} />
          </Field>
          {clinicWarnings(c).filter((w) => w.path !== 'routing').map((w) => <Alert key={w.path} tone="warn">{w.message}</Alert>)}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="min-w-0 space-y-1.5">
              <label htmlFor="voice" className="block text-sm font-medium">Voice</label>
              <div className="flex items-start gap-2">
                <Select id="voice" aria-describedby="voice-hint" value={c.voice} onChange={(e) => set({ voice: e.target.value })}>
                  {/* a voice saved before this list keeps working, and stays selected */}
                  {/* only voices that can be heard here are offered; a clinic that already uses another keeps it */}
                  {!hasPreview(c.voice) && <option value={c.voice}>{voiceLabel(c.voice)} (no preview)</option>}
                  {PREVIEW_VOICES.map((v) => <option key={v} value={v}>{voiceLabel(v)}</option>)}
                </Select>
                <VoicePreview clinicId={clinicId} voice={c.voice} />
              </div>
              <p id="voice-hint" className="text-xs text-text-muted">How the assistant sounds on the phone. Listen plays your saved greeting in the voice chosen here: save a changed greeting first to hear it.</p>
            </div>
            <Field label="Time zone" htmlFor="tz" hint="Times on every page, the opening hours and read-backs use it.">
              <TimeZonePicker id="tz" value={c.timezone} onChange={(timezone) => set({ timezone })} disabled={!writable || save.isPending} />
            </Field>
          </div>
          <div className="space-y-4 border-t border-border pt-5" id="talk">
            <div>
              <h3 className="text-sm font-medium">How the assistant talks</h3>
              <p className="text-xs text-text-muted">It always sounds like a friendly front desk: short turns, everyday words. These set its pace and manner. They never change what it may do. Hear the difference in a test call.</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Pace" htmlFor="talk-pace">
                <Select id="talk-pace" value={c.talk?.pace ?? 'normal'} onChange={(e) => set({ talk: { ...talkOf(c), pace: e.target.value as TalkStyle['pace'] } })}>
                  <option value="relaxed">Relaxed</option><option value="normal">Normal</option><option value="brisk">Brisk</option>
                </Select>
              </Field>
              <Field label="Style" htmlFor="talk-style">
                <Select id="talk-style" value={c.talk?.style ?? defaultTalkStyle(c.industry)} onChange={(e) => set({ talk: { ...talkOf(c), style: e.target.value as TalkStyle['style'] } })}>
                  <option value="warm">Warm and chatty</option><option value="efficient">Friendly and efficient</option><option value="professional">Calm and professional</option>
                </Select>
              </Field>
            </div>
            <Switch id="talk-acks" label="Small acknowledgements" checked={c.talk?.acknowledgements ?? true} disabled={!writable || save.isPending}
              hint={'"Sure", "Got it", "One moment while I check": no silence while it looks something up.'}
              onCheckedChange={(v) => set({ talk: { ...talkOf(c), acknowledgements: v } })} />
          </div>
          <div className="space-y-4 border-t border-border pt-5">
            <Switch id="emergency-transfer" label="Transfer emergencies to on-call" checked={c.emergencyTransferEnabled} onCheckedChange={(v) => set({ emergencyTransferEnabled: v })}
              hint={`After the ${emergencyNumberFor(c)} script, ring the on-call number from Transfers. The script itself always plays and cannot be turned off.`} disabled={!writable || save.isPending} />
            <Switch id="recording" label="Record calls" checked={c.recording.enabled} onCheckedChange={(v) => set({ recording: { ...c.recording, enabled: v } })}
              hint={countryCopy(c).recordingHint} disabled={!writable || save.isPending} />
            {c.recording.enabled && (
              <Field label="Recording notice" htmlFor="notice" hint="Played before anything else, so every caller hears it."><Input id="notice" value={c.recording.notice ?? ''} onChange={(e) => set({ recording: { ...c.recording, notice: e.target.value } })} /></Field>
            )}
          </div>
        </Section>

        <AssistantSection c={c} set={set} disabled={!writable || save.isPending} />

        <Section id="hours" title="Opening hours" description={c.afterHours === 'requests'
          ? 'Outside these hours the assistant still answers and takes requests and callbacks, but books nothing. It transfers only to numbers set for closed hours under Transfers.'
          : 'Outside these hours the assistant still answers, takes callbacks and books. It transfers only to numbers set for closed hours under Transfers.'}>
          <div className="divide-y divide-border rounded-lg border border-border">
            {(['1', '2', '3', '4', '5', '6', '0'] as Day[]).map((d) => (
              <div key={d} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
                <span className="w-24 text-base font-medium">{DAYS[Number(d)]}</span>
                {/* on a phone the times go under the day's name, and a window wraps to two lines rather than past the card */}
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-2 max-md:basis-full">
                  {windows(d).length === 0 && <span className="text-base text-text-muted">Closed</span>}
                  {windows(d).map((w, i) => (
                    <span key={i} className="flex flex-wrap items-center gap-1.5">
                      <Input type="time" aria-label={`${DAYS[Number(d)]} opens`} className="w-32 max-md:w-36" value={w.open} onChange={(e) => setWindows(d, windows(d).map((x, j) => (j === i ? { ...x, open: e.target.value } : x)))} />
                      <span className="text-sm text-text-muted">to</span>
                      <Input type="time" aria-label={`${DAYS[Number(d)]} closes`} className="w-32 max-md:w-36" value={w.close} onChange={(e) => setWindows(d, windows(d).map((x, j) => (j === i ? { ...x, close: e.target.value } : x)))} />
                      <Button type="button" size="icon" variant="ghost" className="text-text-muted hover:text-danger" aria-label={`Remove these ${DAYS[Number(d)]} hours`} onClick={() => setWindows(d, windows(d).filter((_, j) => j !== i))}><Trash2 /></Button>
                    </span>
                  ))}
                </div>
                <Button type="button" size="sm" variant="ghost" onClick={() => setWindows(d, [...windows(d), windows(d).length ? { open: '13:00', close: '17:00' } : { open: '08:00', close: '17:00' }])}>
                  <Plus /> {windows(d).length ? 'More hours' : 'Open this day'}
                </Button>
              </div>
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="While you are closed" htmlFor="after-hours" hint="Taking requests lets the team book in the morning, after a person has looked at each one.">
              <Select id="after-hours" value={c.afterHours} onChange={(e) => set({ afterHours: e.target.value as ClinicConfig['afterHours'] })}>
                <option value="book">Book visits, as during opening hours</option>
                <option value="requests">Take requests; the team books in the morning</option>
              </Select>
            </Field>
            <Field label="Average visit value" htmlFor="visit-value" hint={c.afterHours === 'requests' ? 'The weekly report counts each request taken while you were closed as a visit kept, at this value.' : 'The weekly report counts visits booked after hours at this value, as money saved.'}>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-base text-text-muted" aria-hidden>{countryCopy(c).currency}</span>
                <Input id="visit-value" type="number" min={0} max={100000} className={countryCopy(c).currency.length > 1 ? 'pl-11' : 'pl-7'} value={c.averageVisitValue} onChange={(e) => set({ averageVisitValue: Number(e.target.value) })} />
              </div>
            </Field>
          </div>
        </Section>

        <Section id="holidays" title="Holidays and special days" description="Days that differ from the weekly hours: a holiday, closed all day, or a special day, closed with a reason or open shorter hours. Nothing is offered outside them, and the assistant tells callers. Adding one never moves a visit already booked: the Schedule lists any to move.">
          <ConflictsAlert clinicId={clinicId} />
          <div className="flex flex-wrap gap-2">
            <Input type="date" aria-label="Holiday date" className="w-44" value={newHoliday} onChange={(e) => setNewHoliday(e.target.value)} />
            <Button type="button" variant="outline" disabled={!newHoliday || c.holidays.includes(newHoliday) || !!c.specialDays?.some((d) => d.date === newHoliday)} onClick={() => { set({ holidays: [...c.holidays, newHoliday].sort() }); setNewHoliday(''); }}><Plus /> Add holiday</Button>
          </div>
          {c.holidays.length === 0 ? <EmptyNote>No holidays set.</EmptyNote> : (
            <div className="flex flex-wrap gap-2">
              {c.holidays.map((h) => (
                <span key={h} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-sunken/60 py-1 pl-3 pr-1.5 text-sm">
                  {dayTitle(h, 'short')} {h.slice(0, 4)}
                  <button type="button" aria-label={`Remove ${h}`} className="focus-ring rounded-full p-0.5 text-text-muted hover:text-danger" onClick={() => set({ holidays: c.holidays.filter((x) => x !== h) })}><X className="size-3.5" /></button>
                </span>
              ))}
            </div>
          )}
          <h3 className="pt-2 text-base font-medium">Special days</h3>
          <SpecialDaysEditor days={c.specialDays ?? []} holidays={c.holidays} onChange={(specialDays) => set({ specialDays })} />
        </Section>

        {(pet || c.emergencyHospital) && (
          <Section id="emergency" title="Emergency hospitals" description="Where the assistant sends a caller whose animal is in danger, with the address and phone. It names your first choice that is open at that moment. With none set or none open, callers are told to go to the nearest 24-hour emergency vet."
            action={<Button type="button" size="sm" variant="outline" disabled={hospitals.length >= 5} onClick={() => addOrFocus(hospitals, BLANK.hospital, (_h, i) => `item-hospital-${i}`, () => { setHospitals([{ name: '', phone: '', address: '' }, ...hospitals]); setAdded('item-hospital-0'); })}><Plus /> Hospital</Button>}>
            {hospitals.length === 0 && <EmptyNote>No emergency hospital yet. Add the one you send clients to at night.</EmptyNote>}
            <Sortable items={hospitals} keyOf={(_h, i) => String(i)} label={(h) => h.name} disabled={!writable || save.isPending} onMove={(f, t) => setHospitals(moved(hospitals, f, t))} className="space-y-5">
            {(h, i, handle) => {
              const upd = (patch: Partial<typeof h>) => setHospitals(hospitals.map((x, j) => (j === i ? { ...x, ...patch } : x)));
              return (
                <Item handle={handle} id={`item-hospital-${i}`} removeLabel={`Remove ${h.name || 'this hospital'}`} onRemove={() => setHospitals(hospitals.filter((_, j) => j !== i))}>
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={i === 0 ? 'accent' : 'neutral'}>{i === 0 ? 'First choice' : `Choice ${i + 1}`}</Badge>
                      {i > 0 && <Button type="button" size="sm" variant="ghost" onClick={() => setHospitals([h, ...hospitals.filter((_, j) => j !== i)])}>Make first choice</Button>}
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="Hospital name"><Input value={h.name} placeholder="e.g. City Pet Emergency" onChange={(e) => upd({ name: e.target.value })} /></Field>
                      <Field label="Phone" hint="With the country code."><Input type="tel" value={h.phone} placeholder={countryCopy(c).phone.e164} onChange={(e) => upd({ phone: e.target.value.replace(/[^\d+]/g, '') })} /></Field>
                    </div>
                    <Field label="Address" hint="Read to callers as written."><Input value={h.address} placeholder="e.g. 1200 Main Street, Denver" onChange={(e) => upd({ address: e.target.value })} /></Field>
                    <Switch id={`hospital-24h-${i}`} label="Open 24 hours" checked={!h.hours} onCheckedChange={(on) => upd({ hours: on ? undefined : { open: '18:00', close: '08:00' } })} disabled={!writable || save.isPending}
                      hint="Turn off for a hospital that only takes emergencies part of the day, like evenings and nights." />
                    {h.hours && (
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="text-text-muted">Every day from</span>
                        <Input type="time" aria-label={`${h.name || 'Hospital'} opens`} className="w-32" value={h.hours.open} onChange={(e) => upd({ hours: { ...h.hours!, open: e.target.value } })} />
                        <span className="text-text-muted">to</span>
                        <Input type="time" aria-label={`${h.name || 'Hospital'} closes`} className="w-32" value={h.hours.close} onChange={(e) => upd({ hours: { ...h.hours!, close: e.target.value } })} />
                        <span className="text-xs text-text-muted">A closing time before the opening time runs past midnight.</span>
                      </div>
                    )}
                  </div>
                </Item>
              );
            }}
            </Sortable>
          </Section>
        )}

        <Section id="visits" title="Visit types" description="What callers can book, how long each takes, and when the assistant may book it."
          action={<Button type="button" size="sm" variant="outline" onClick={() => addOrFocus(c.visitTypes, BLANK.named, (v) => `item-${v.id}`, () => { const id = newId('vt', 'visit'); set({ visitTypes: [{ id, name: '', minutes: 20, audience: 'all' }, ...c.visitTypes] }); setAdded(`item-${id}`); })}><Plus /> Visit type</Button>}>
          <Sortable items={c.visitTypes} keyOf={(v) => v.id} label={(v) => v.name} disabled={!writable || save.isPending} onMove={(f, t) => set({ visitTypes: moved(c.visitTypes, f, t) })} className="space-y-5">
          {(v, i, handle) => (
            <Item handle={handle} id={`item-${v.id}`} removeLabel={`Remove ${v.name || 'this visit type'}`} onRemove={() => set({
              visitTypes: c.visitTypes.filter((_, j) => j !== i),
              // taken off every provider who offered it, on the server too
              providers: c.providers.map((p) => ({ ...p, visitTypeIds: p.visitTypeIds.filter((id) => id !== v.id) })),
            })}>
              <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_7rem_minmax(0,14rem)]">
                  <Field label="Name"><Input value={v.name} placeholder="e.g. Dental cleaning" onChange={(e) => visit(i, { name: e.target.value })} /></Field>
                  <Field label="Minutes"><Input type="number" min={5} max={240} value={v.minutes} onChange={(e) => visit(i, { minutes: Number(e.target.value) })} /></Field>
                  <Field label="Who can book it">
                    <Select value={v.audience} aria-label={`${v.name}: who can book it`} onChange={(e) => visit(i, { audience: e.target.value as 'all' | 'new' | 'existing' })}>
                      <option value="all">Anyone</option>
                      <option value="new">{pet ? 'New clients only' : 'New patients only'}</option>
                      <option value="existing">{pet ? 'Pets already on file' : 'Patients on file only'}</option>
                    </Select>
                  </Field>
                </div>
                {c.languages.some((l) => l !== 'en') && <div className="grid gap-4 sm:grid-cols-2"><LocalNames thing={v} languages={c.languages} what="Visit type" onChange={(names) => visit(i, { names })} /></div>}
                <Field label="What it is, for callers" hint="Optional. Said when a caller asks what it includes.">
                  <Input maxLength={300} value={v.description ?? ''} placeholder={pet ? 'e.g. Core vaccines and a full check-up' : 'e.g. A full check-up and any tests due'}
                    onChange={(e) => visit(i, { description: e.target.value || undefined })} />
                </Field>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Notice, in hours" hint="Booked at least this far ahead. Empty: 2 hours.">
                    <Input type="number" min={0} max={720} value={v.noticeHours ?? ''} placeholder="2" aria-label={`${v.name}: notice in hours`} onChange={(e) => visit(i, { noticeHours: num(e.target.value) })} />
                  </Field>
                  <Field label="Up to, days ahead" hint="Booked at most this far out. Empty: no limit.">
                    <Input type="number" min={1} max={365} value={v.maxDaysAhead ?? ''} placeholder="No limit" aria-label={`${v.name}: days ahead`} onChange={(e) => visit(i, { maxDaysAhead: num(e.target.value) })} />
                  </Field>
                  <Field label="Free after, in minutes" hint="Kept free after each one, on calls and at the desk.">
                    <Input type="number" min={0} max={120} value={v.bufferMinutes ?? ''} placeholder="0" aria-label={`${v.name}: minutes free after`} onChange={(e) => visit(i, { bufferMinutes: num(e.target.value) })} />
                  </Field>
                </div>
                <Switch id={`staff-only-${v.id}`} label="Team books it" hint="The assistant never offers times for it. It takes a request for the team instead."
                  checked={!!v.staffOnly} onCheckedChange={(on) => visit(i, { staffOnly: on || undefined })} disabled={!writable || save.isPending} />
              </div>
            </Item>
          )}
          </Sortable>
          <p className="text-sm text-text-muted">
            {terms.title('providers')} have a page of their own, where you add them, set their hours and days off, and choose which visits each one does.{' '}
            <Link className="font-medium text-primary hover:underline" href={`/c/${clinicId}/doctors`}>Open {terms.title('providers')}</Link>
          </p>
        </Section>

        <BookingRulesSection c={c} set={set} disabled={!writable || save.isPending} terms={terms} />

        <Section id="transfers" title="Transfers" description="Where the assistant sends a caller who asks for a person, and when. It transfers only to these numbers. Once the call is passed on, that line's own phone system handles it, voicemail included; if the transfer itself fails, the assistant stays on and offers a callback."
          action={<Button type="button" size="sm" variant="outline" onClick={() => addOrFocus(c.routing, (r) => BLANK.number(r.uri, c), (_r, i) => `item-routing-${i}`, () => { set({ routing: [{ target: 'front_desk', uri: `tel:+${callingCode(c.phoneNumbers[0] ?? '') ?? ''}`, when: 'open', priority: 0 }, ...c.routing] }); setAdded('item-routing-0'); })}><Plus /> Transfer number</Button>}>
          {clinicWarnings(c).filter((w) => w.path === 'routing').map((w) => <Alert key={w.path} tone="warn">{w.message}</Alert>)}
          {c.routing.length === 0 && <EmptyNote>No transfer numbers yet. Callers who ask for a person get a callback request.</EmptyNote>}
          <Sortable items={c.routing} keyOf={(_r, i) => String(i)} label={(r) => shownUri(r.uri)} disabled={!writable || save.isPending} onMove={(f, t) => set({ routing: moved(c.routing, f, t) })} className="space-y-5">
          {(r, i, handle) => (
            <Item handle={handle} id={`item-routing-${i}`} removeLabel="Remove this transfer number" onRemove={() => remove('routing', i)}>
              <div className="grid gap-4 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_minmax(0,11rem)]">
                <Field label="Who it reaches">
                  <Select value={r.target} onChange={(e) => upd('routing', i, { target: e.target.value as typeof r.target })}>
                    <option value="front_desk">Front desk</option><option value="billing">Billing</option><option value="on_call">On-call {terms.provider}</option>
                  </Select>
                </Field>
                <Field label="Phone number" hint="With the country code.">
                  <Input type="tel" value={shownUri(r.uri)} placeholder={countryCopy(c).phone.e164} onChange={(e) => upd('routing', i, { uri: storedUri(e.target.value) })} />
                </Field>
                <Field label="When">
                  <Select value={r.when} onChange={(e) => upd('routing', i, { when: e.target.value as typeof r.when })}>
                    <option value="open">While open</option><option value="closed">While closed</option><option value="always">Always</option>
                  </Select>
                </Field>
              </div>
            </Item>
          )}
          </Sortable>
        </Section>

        <Section id="vip" title="VIP callers" description="Callers who should always reach a person. While your front desk number (under Transfers) takes calls, the assistant greets them, says it is connecting them, and passes the call to that number. If the transfer does not go through, the assistant stays on and offers a callback; if it rings and nobody answers, your own phone system takes it from there. Outside front desk hours the assistant answers them as usual."
          action={<Button type="button" size="sm" variant="outline" disabled={(c.vipCallers?.length ?? 0) >= 50} onClick={() => addOrFocus(c.vipCallers ?? [], (v) => !v.name.trim() && BLANK.number(v.phone, c), (_v, i) => `item-vip-${i}`, () => { set({ vipCallers: [{ name: '', phone: '' }, ...(c.vipCallers ?? [])] }); setAdded('item-vip-0'); })}><Plus /> VIP caller</Button>}>
          {!c.routing.some((r) => r.target === 'front_desk') && !!c.vipCallers?.length && <Alert tone="warn">Add a front desk number under Transfers, or VIP callers reach the assistant like anyone else.</Alert>}
          {!c.vipCallers?.length && <EmptyNote>No VIP callers yet.</EmptyNote>}
          <Sortable items={(c.vipCallers ?? [])} keyOf={(_v, i) => String(i)} label={(v) => v.name} disabled={!writable || save.isPending} onMove={(f, t) => set({ vipCallers: moved(c.vipCallers ?? [], f, t) })} className="space-y-5">
          {(v, i, handle) => (
            <Item handle={handle} id={`item-vip-${i}`} removeLabel="Remove VIP caller" onRemove={() => remove('vipCallers', i)}>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Who"><Input maxLength={60} value={v.name} placeholder="e.g. Partner clinic" onChange={(e) => upd('vipCallers', i, { name: e.target.value })} /></Field>
                <Field label="Phone number" hint="With the country code."><Input type="tel" value={v.phone} placeholder={countryCopy(c).phone.e164} onChange={(e) => upd('vipCallers', i, { phone: e.target.value.replace(/[^\d+]/g, '') })} /></Field>
              </div>
            </Item>
          )}
          </Sortable>
        </Section>

        <Section id="answers" title="Answers to common questions" description="The assistant answers from these, in your words, and does not make up the rest."
          action={<Button type="button" size="sm" variant="outline" onClick={() => addOrFocus(c.faqs, (f) => !f.question.trim() && !f.answer.trim(), (f) => `item-${f.id}`, () => { const id = newId('faq', 'question'); set({ faqs: [{ id, question: '', answer: '' }, ...c.faqs] }); setAdded(`item-${id}`); })}><Plus /> Question</Button>}>
          {c.faqs.length === 0 && <EmptyNote>No answers yet. Add the questions callers ask most, like parking, payment or what to bring.</EmptyNote>}
          <Sortable items={c.faqs} keyOf={(f) => f.id} label={(f) => f.question} disabled={!writable || save.isPending} onMove={(f, t) => set({ faqs: moved(c.faqs, f, t) })} className="space-y-5">
          {(f, i, handle) => (
            <Item handle={handle} id={`item-${f.id}`} removeLabel="Remove question" onRemove={() => remove('faqs', i)}>
              <div className="space-y-4">
                <Field label="Question"><Input value={f.question} placeholder="e.g. Where do I park?" onChange={(e) => upd('faqs', i, { question: e.target.value })} /></Field>
                <Field label="Answer" hint={`${f.answer.length}/600`}><Textarea maxLength={600} value={f.answer} placeholder="e.g. Free parking behind the building, entrance on 5th Street." onChange={(e) => upd('faqs', i, { answer: e.target.value })} /></Field>
              </div>
            </Item>
          )}
          </Sortable>
        </Section>

        <Section id="offers" title="Offers and announcements" description="What you are running now, like a vaccine clinic or a dental month. The assistant tells callers who ask, only between the dates you set."
          action={<Button type="button" size="sm" variant="outline" onClick={() => addOrFocus(c.offers ?? [], (o) => !o.title.trim() && !o.details.trim(), (o) => `item-${o.id}`, () => { const id = newId('offer', 'offer'); set({ offers: [{ id, title: '', details: '' }, ...(c.offers ?? [])] }); setAdded(`item-${id}`); })}><Plus /> Offer</Button>}>
          {!c.offers?.length && <EmptyNote>No offers running.</EmptyNote>}
          <Sortable items={(c.offers ?? [])} keyOf={(o) => o.id} label={(o) => o.title} disabled={!writable || save.isPending} onMove={(f, t) => set({ offers: moved(c.offers ?? [], f, t) })} className="space-y-5">
          {(o, i, handle) => (
            <Item handle={handle} id={`item-${o.id}`} removeLabel="Remove offer" onRemove={() => remove('offers', i)}>
              <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem_10rem]">
                  <Field label="Title"><Input maxLength={80} value={o.title} placeholder="e.g. Saturday vaccine clinic" onChange={(e) => upd('offers', i, { title: e.target.value })} /></Field>
                  <Field label="From" hint="Optional."><Input type="date" value={o.from ?? ''} onChange={(e) => upd('offers', i, { from: e.target.value || undefined })} /></Field>
                  <Field label="To" hint="Optional."><Input type="date" value={o.to ?? ''} min={o.from} onChange={(e) => upd('offers', i, { to: e.target.value || undefined })} /></Field>
                </div>
                <Field label="Details" hint={`${o.details.length}/400`}><Textarea maxLength={400} value={o.details} placeholder="e.g. Core vaccines for dogs and cats, 9 to 1, no appointment needed." onChange={(e) => upd('offers', i, { details: e.target.value })} /></Field>
              </div>
            </Item>
          )}
          </Sortable>
        </Section>

        <Section id="fields" title="Fields and lists" description={`Your own fields on ${terms.patients}, ${terms.providers} and requests, the kinds of request the assistant labels, and the lists they pick from have their own tab.`}>
          <div className="flex flex-wrap gap-2">
            <Link href={`/c/${clinicId}/settings/fields?tab=patients`} className={buttonStyles({ variant: 'outline', size: 'sm' })}>Fields on {terms.patients}</Link>
            <Link href={`/c/${clinicId}/settings/fields?tab=providers`} className={buttonStyles({ variant: 'outline', size: 'sm' })}>{terms.title('providers')} and their lists</Link>
            <Link href={`/c/${clinicId}/settings/fields?tab=requests`} className={buttonStyles({ variant: 'outline', size: 'sm' })}>Requests and kinds of request</Link>
          </div>
        </Section>

        <Section id="links" title="Links in your menu" description="Shortcuts for your team, not for callers: your practice software, a lab portal, a form. Each shows in this dashboard's menu on the left, for everyone at the clinic, and opens in a new tab. The assistant does not use them; links it may text a caller are under Texting."
          action={<Button type="button" size="sm" variant="outline" disabled={(c.menuLinks?.length ?? 0) >= 8} onClick={() => addOrFocus(c.menuLinks ?? [], (l) => !l.label.trim() && /^(https?:\/\/)?$/.test(l.url.trim()), (_l, i) => `item-link-${i}`, () => { set({ menuLinks: [{ label: '', url: 'https://' }, ...(c.menuLinks ?? [])] }); setAdded('item-link-0'); })}><Plus /> Link</Button>}>
          {!c.menuLinks?.length && <EmptyNote>No links yet.</EmptyNote>}
          <Sortable items={(c.menuLinks ?? [])} keyOf={(_l, i) => String(i)} label={(l) => l.label} disabled={!writable || save.isPending} onMove={(f, t) => set({ menuLinks: moved(c.menuLinks ?? [], f, t) })} className="space-y-5">
          {(l, i, handle) => (
            <Item handle={handle} id={`item-link-${i}`} removeLabel="Remove link" onRemove={() => remove('menuLinks', i)}>
              <div className="grid gap-4 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
                <Field label="Label"><Input maxLength={30} value={l.label} placeholder="e.g. Practice software" onChange={(e) => upd('menuLinks', i, { label: e.target.value })} /></Field>
                <Field label="Web address"><Input type="url" value={l.url} placeholder="https://" onChange={(e) => upd('menuLinks', i, { url: e.target.value })} /></Field>
              </div>
            </Item>
          )}
          </Sortable>
        </Section>

        <Section id="records" title="Call records" description="Transcripts and call summaries are deleted once they are older than this. The call itself stays in the list, with its outcome, and the audit log keeps how many were deleted.">
          <Field label="Keep transcripts and summaries for" htmlFor="retention" hint="One year unless you choose otherwise; three years at most. Your own records system keeps the medical record.">
            <Select id="retention" className="w-48" value={String(c.retentionDays)} onChange={(e) => set({ retentionDays: Number(e.target.value) })}>
              {[...new Set([...RETENTION_CHOICES, c.retentionDays])].sort((a, b) => a - b).map((d) => <option key={d} value={d}>{d % 365 === 0 ? `${d / 365} year${d === 365 ? '' : 's'}` : d === 180 ? '6 months' : `${d} days`}</option>)}
            </Select>
          </Field>
        </Section>

        <Section id="numbers" title="Phone numbers" description={`The assistant's number is where calls reach the assistant${clinic?.accountLinks.length ? ': to get or change it, open Phone number under Account in the menu' : ': your Attendra operator sets it up'}. Your clinic's own line is the number clients call today; you forward it to the assistant's number, and "Check my forwarding" calls it.`}>
          <ul className="space-y-2">
            {c.phoneNumbers.map((n, i) => (assistantNumbers.has(n) ? (
              <li key={`a-${n}`} className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface-sunken/60 px-3 py-2 text-sm">
                <span className="font-medium tabular-nums">{phone(n)}</span>
                <span className="text-text-muted">Your assistant&apos;s number: calls to it reach the assistant</span>
              </li>
            ) : (
              <li key={`own-${i}`} className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2 text-sm">
                {/* typed as the clinic writes it; kept as +1… so forwarding checks and texts can use it */}
                <Input aria-label="Your clinic's own line" className="h-8 w-48 tabular-nums" defaultValue={n ? phone(n) : ''} disabled={!writable} placeholder={countryCopy(c).phone.local}
                  onBlur={(e) => { const v = e.target.value.trim() ? asE164(c, e.target.value) : ''; if (v !== n) set({ phoneNumbers: c.phoneNumbers.map((x, j) => (j === i ? v : x)) }); }} />
                <span className="text-text-muted">Your clinic&apos;s own line: forward it to the assistant&apos;s number</span>
                {writable && <Button type="button" size="sm" variant="ghost" onClick={() => set({ phoneNumbers: c.phoneNumbers.filter((_, j) => j !== i) })}>Remove</Button>}
              </li>
            )))}
          </ul>
          {writable && c.phoneNumbers.filter((n) => !assistantNumbers.has(n)).length < 3 && (
            <Button type="button" size="sm" variant="outline" className="mt-3" onClick={() => set({ phoneNumbers: [...c.phoneNumbers, ''] })}><Plus /> Your clinic&apos;s own line</Button>
          )}
        </Section>
      </fieldset>
      </div>

      {writable && dirty && (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-surface/95 backdrop-blur md:left-16 xl:left-60">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 md:px-8">
            <p className="text-sm text-text-muted">You have unsaved changes.</p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setDraft(saved.data ?? null)}>Discard</Button>
              <Button onClick={() => save.mutate(withoutBlankRows(c))} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save changes'}</Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
