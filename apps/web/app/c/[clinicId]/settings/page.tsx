// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { BUILT_IN_VOICES, type ClinicConfig, clinicWarnings, countryCopy, emergencyNumberFor, voiceLabel } from '@attendra/core';
import type { ApiError } from '@attendra/api/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AssistantSection, LocalNames } from '@/components/settings/assistant';
import { Field, Section } from '@/components/settings/section';
import { SettingsNav } from '@/components/settings/settings-nav';
import { TimeZonePicker } from '@/components/settings/time-zone-picker';
import { Switch } from '@/components/ui/controls';
import { PageHeader } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { Alert, Skeleton } from '@/components/ui/feedback';
import { Input, Select, Textarea } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { api, ApiFailure, useClinic } from '@/lib/api';
import { DAYS } from '@/lib/format';

type Day = '0' | '1' | '2' | '3' | '4' | '5' | '6';
const select = 'h-9 rounded-md border border-border-strong bg-surface px-2 text-sm';
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'new';
const newId = (prefix: string, name: string) => `${prefix}_${slug(name)}_${Math.random().toString(36).slice(2, 6)}`;

export default function Settings() {
  const { clinicId } = useParams<{ clinicId: string }>();
  const { can } = useClinic(clinicId);
  const queries = useQueryClient();
  const toast = useToast();
  const saved = useQuery({ queryKey: ['settings', clinicId], queryFn: () => api<ClinicConfig>(`/clinics/${clinicId}/settings`) });
  const [draft, setDraft] = useState<ClinicConfig | null>(null);
  const [issues, setIssues] = useState<ApiError['issues']>([]);
  const [newHoliday, setNewHoliday] = useState('');
  useEffect(() => { if (saved.data && !draft) setDraft(saved.data); }, [saved.data, draft]);

  const save = useMutation({
    mutationFn: (config: ClinicConfig) => api<ClinicConfig>(`/clinics/${clinicId}/settings`, { method: 'PUT', body: JSON.stringify(config) }),
    onMutate: () => setIssues([]),
    onSuccess: (config) => {
      queries.setQueryData(['settings', clinicId], config);
      // the clinic's name and time zone also come with who you are, for every other page
      void queries.invalidateQueries({ queryKey: ['me'] });
      setDraft(config);
      toast({ tone: 'success', message: 'Saved. The next call uses these settings.' });
    },
    onError: (e) => { if (e instanceof ApiFailure) setIssues(e.body.issues ?? [{ path: '', message: e.message }]); },
  });

  if (saved.isError) return <><PageHeader title="Settings" /><Alert tone="danger">The clinic settings did not load. Refresh the page; if it keeps failing, check that the API is running.</Alert></>;
  if (!draft) return <><PageHeader title="Settings" /><Skeleton className="h-96" /></>;
  const c = draft;
  const set = (patch: Partial<ClinicConfig>) => setDraft({ ...c, ...patch });
  const dirty = JSON.stringify(c) !== JSON.stringify(saved.data);
  const writable = can('settings:write');

  const windows = (d: Day) => c.hours[d] ?? [];
  const setWindows = (d: Day, w: { open: string; close: string }[]) => set({ hours: { ...c.hours, [d]: w } });

  return (
    <>
      <PageHeader title="Settings" description="What the assistant says, when the clinic is open, and what it can book. Changes apply to the next call." />
      <SettingsNav clinicId={clinicId} />
      {!writable && <Alert className="mb-6">You can read these settings. A practice manager or owner can change them.</Alert>}
      {issues && issues.length > 0 && (
        <Alert tone="danger" title="Not saved. Fix these first:" className="mb-6">
          <ul className="list-disc pl-4">{issues.map((i, n) => <li key={n}><span className="font-mono text-xs">{i.path || 'settings'}</span>: {i.message}</li>)}</ul>
        </Alert>
      )}
      <fieldset disabled={!writable || save.isPending} className="space-y-6 pb-24">
        <Section title="Greeting and voice" description="Callers must hear that they are talking to an AI assistant. The greeting cannot be saved without it.">
          <Field label="Clinic name" htmlFor="name"><Input id="name" value={c.name} onChange={(e) => set({ name: e.target.value })} /></Field>
          <Field label="Greeting" htmlFor="greeting" hint={`${c.greeting.length}/400. Mention "AI assistant", "virtual receptionist" or similar.`}>
            <Textarea id="greeting" value={c.greeting} maxLength={400} onChange={(e) => set({ greeting: e.target.value })} />
          </Field>
          {clinicWarnings(c).map((w) => <Alert key={w.path} tone="warn">{w.message}</Alert>)}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Voice" htmlFor="voice" hint="How the assistant sounds on the phone.">
              <Select id="voice" value={c.voice} onChange={(e) => set({ voice: e.target.value })}>
                {/* a voice saved before this list keeps working, and stays selected */}
                {!(BUILT_IN_VOICES as readonly string[]).includes(c.voice) && <option value={c.voice}>{voiceLabel(c.voice)}</option>}
                {BUILT_IN_VOICES.map((v) => <option key={v} value={v}>{voiceLabel(v)}</option>)}
              </Select>
            </Field>
            <Field label="Time zone" htmlFor="tz" hint="Times on every page, the opening hours and read-backs use it.">
              <TimeZonePicker id="tz" value={c.timezone} onChange={(timezone) => set({ timezone })} disabled={!writable || save.isPending} />
            </Field>
          </div>
          <Switch id="emergency-transfer" label="Transfer emergencies to on-call" checked={c.emergencyTransferEnabled} onCheckedChange={(v) => set({ emergencyTransferEnabled: v })}
            hint={`After the ${emergencyNumberFor(c)} script, ring the on-call line from Routing. The script itself always plays and cannot be turned off.`} disabled={!writable || save.isPending} />
          <Switch id="recording" label="Record calls" checked={c.recording.enabled} onCheckedChange={(v) => set({ recording: { ...c.recording, enabled: v } })}
            hint={countryCopy(c).recordingHint} disabled={!writable || save.isPending} />
          {c.recording.enabled && (
            <Field label="Recording notice" htmlFor="notice"><Input id="notice" value={c.recording.notice ?? ''} onChange={(e) => set({ recording: { ...c.recording, notice: e.target.value } })} /></Field>
          )}
        </Section>

        <AssistantSection c={c} set={set} disabled={!writable || save.isPending} />

        <Section title="Opening hours" description="Outside these hours the assistant still answers, takes callbacks and books, but does not transfer to the front desk.">
          {(['1', '2', '3', '4', '5', '6', '0'] as Day[]).map((d) => (
            <div key={d} className="flex flex-wrap items-center gap-3 border-b border-border pb-3 last:border-0 last:pb-0">
              <span className="w-24 text-sm font-medium">{DAYS[Number(d)]}</span>
              {windows(d).length === 0 && <span className="text-sm text-text-muted">Closed</span>}
              {windows(d).map((w, i) => (
                <span key={i} className="flex items-center gap-1.5">
                  <Input type="time" aria-label={`${DAYS[Number(d)]} opens`} className="w-36" value={w.open} onChange={(e) => setWindows(d, windows(d).map((x, j) => (j === i ? { ...x, open: e.target.value } : x)))} />
                  <span className="text-text-muted">to</span>
                  <Input type="time" aria-label={`${DAYS[Number(d)]} closes`} className="w-36" value={w.close} onChange={(e) => setWindows(d, windows(d).map((x, j) => (j === i ? { ...x, close: e.target.value } : x)))} />
                  <Button type="button" size="sm" variant="ghost" aria-label="Remove hours" onClick={() => setWindows(d, windows(d).filter((_, j) => j !== i))}><Trash2 /></Button>
                </span>
              ))}
              <Button type="button" size="sm" variant="ghost" onClick={() => setWindows(d, [...windows(d), { open: '08:00', close: '17:00' }])}><Plus /> Hours</Button>
            </div>
          ))}
        </Section>

        <Section title="Holidays" description="Closed all day. Nothing is offered on these dates.">
          <div className="flex flex-wrap gap-2">
            {c.holidays.length === 0 && <span className="text-sm text-text-muted">None set.</span>}
            {c.holidays.map((h) => (
              <span key={h} className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1 text-sm">
                {h}
                <button type="button" aria-label={`Remove ${h}`} className="text-text-muted hover:text-danger" onClick={() => set({ holidays: c.holidays.filter((x) => x !== h) })}><Trash2 className="size-3.5" /></button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <Input type="date" aria-label="Holiday date" className="w-44" value={newHoliday} onChange={(e) => setNewHoliday(e.target.value)} />
            <Button type="button" variant="outline" disabled={!newHoliday || c.holidays.includes(newHoliday)} onClick={() => { set({ holidays: [...c.holidays, newHoliday].sort() }); setNewHoliday(''); }}>Add holiday</Button>
          </div>
        </Section>

        <Section title="Visit types" description="What callers can book, with how long each takes."
          action={<Button type="button" size="sm" variant="outline" onClick={() => set({ visitTypes: [...c.visitTypes, { id: newId('vt', 'visit'), name: 'New visit type', minutes: 20, audience: 'all' }] })}><Plus /> Visit type</Button>}>
          {c.visitTypes.map((v, i) => (
            <div key={v.id} className="flex flex-wrap items-end gap-3">
              <Field label="Name"><Input className="w-64" value={v.name} onChange={(e) => set({ visitTypes: c.visitTypes.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} /></Field>
              <LocalNames thing={v} languages={c.languages} what="Visit type" onChange={(names) => set({ visitTypes: c.visitTypes.map((x, j) => (j === i ? { ...x, names } : x)) })} />
              <Field label="Minutes"><Input type="number" min={5} max={240} className="w-24" value={v.minutes} onChange={(e) => set({ visitTypes: c.visitTypes.map((x, j) => (j === i ? { ...x, minutes: Number(e.target.value) } : x)) })} /></Field>
              <Field label="Who can book it">
                <Select className="w-52" value={v.audience} aria-label={`${v.name}: who can book it`}
                  onChange={(e) => set({ visitTypes: c.visitTypes.map((x, j) => (j === i ? { ...x, audience: e.target.value as 'all' | 'new' | 'existing' } : x)) })}>
                  <option value="all">Anyone</option><option value="new">New patients only</option><option value="existing">Patients on file only</option>
                </Select>
              </Field>
              <Button type="button" size="sm" variant="ghost" aria-label={`Remove ${v.name}`} onClick={() => set({
                visitTypes: c.visitTypes.filter((_, j) => j !== i),
                // taken off every doctor who offered it, on the server too
                providers: c.providers.map((p) => ({ ...p, visitTypeIds: p.visitTypeIds.filter((id) => id !== v.id) })),
              })}><Trash2 /></Button>
            </div>
          ))}
        </Section>

        <Section title="Doctors" description="Who can be booked, their specialties, the ages they see, their weekly hours and days off.">
          <p className="text-sm text-text-muted">
            Doctors have a page of their own, where managers add them, set their hours and days off, or import a list. Saving these settings never changes them.{' '}
            <Link className="font-medium text-primary hover:underline" href={`/c/${clinicId}/doctors`}>Open Doctors</Link>
          </p>
        </Section>

        <Section title="Routing" description="Where transfers go. The assistant transfers only to these numbers."
          action={<Button type="button" size="sm" variant="outline" onClick={() => set({ routing: [...c.routing, { target: 'front_desk', uri: 'tel:+1', when: 'open', priority: 0 }] })}><Plus /> Rule</Button>}>
          {c.routing.length === 0 && <p className="text-sm text-text-muted">No transfers set up. Callers who ask for a person get a callback request.</p>}
          {c.routing.map((r, i) => {
            const upd = (patch: Partial<typeof r>) => set({ routing: c.routing.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
            return (
              <div key={i} className="flex flex-wrap items-end gap-3">
                <Field label="Target">
                  <select className={select} value={r.target} onChange={(e) => upd({ target: e.target.value as typeof r.target })}>
                    <option value="front_desk">Front desk</option><option value="billing">Billing</option><option value="on_call">On-call provider</option>
                  </select>
                </Field>
                <Field label="Number or SIP address"><Input className="w-56 font-mono" value={r.uri} onChange={(e) => upd({ uri: e.target.value })} /></Field>
                <Field label="When">
                  <select className={select} value={r.when} onChange={(e) => upd({ when: e.target.value as typeof r.when })}>
                    <option value="open">Open hours</option><option value="closed">Closed hours</option><option value="always">Always</option>
                  </select>
                </Field>
                <Button type="button" size="sm" variant="ghost" aria-label="Remove rule" onClick={() => set({ routing: c.routing.filter((_, j) => j !== i) })}><Trash2 /></Button>
              </div>
            );
          })}
        </Section>

        <Section title="Answers to common questions" description="The assistant answers from these, in your words, and does not make up the rest."
          action={<Button type="button" size="sm" variant="outline" onClick={() => set({ faqs: [...c.faqs, { id: newId('faq', 'question'), question: '', answer: '' }] })}><Plus /> Question</Button>}>
          {c.faqs.map((f, i) => (
            <div key={f.id} className="space-y-2 border-b border-border pb-4 last:border-0 last:pb-0">
              <div className="flex items-end gap-3">
                <div className="flex-1"><Field label="Question"><Input value={f.question} onChange={(e) => set({ faqs: c.faqs.map((x, j) => (j === i ? { ...x, question: e.target.value } : x)) })} /></Field></div>
                <Button type="button" size="sm" variant="ghost" aria-label="Remove question" onClick={() => set({ faqs: c.faqs.filter((_, j) => j !== i) })}><Trash2 /></Button>
              </div>
              <Field label="Answer" hint={`${f.answer.length}/600`}><Textarea maxLength={600} value={f.answer} onChange={(e) => set({ faqs: c.faqs.map((x, j) => (j === i ? { ...x, answer: e.target.value } : x)) })} /></Field>
            </div>
          ))}
        </Section>

        <Section title="Call records" description="Transcripts and call summaries are deleted once they are older than this. The call itself stays in the list, with its outcome, and the audit log keeps how many were deleted.">
          <Field label="Keep transcripts, summaries, call actions and webhook events for (days)" htmlFor="retention" hint={`${c.retentionDays} days is about ${(c.retentionDays / 365).toFixed(1)} years. The default, 2555 days, is about 7 years. Between 30 and 3650.`}>
            <Input id="retention" type="number" min={30} max={3650} className="w-28" value={c.retentionDays} onChange={(e) => set({ retentionDays: Number(e.target.value) })} />
          </Field>
        </Section>

        <Section title="Phone numbers" description="Managed by your Attendra operator, who connects them to the SIP trunk.">
          <p className="font-mono text-sm">{c.phoneNumbers.join(', ')}</p>
        </Section>
      </fieldset>

      {writable && dirty && (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-surface/95 backdrop-blur md:left-16 xl:left-60">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 md:px-8">
            <p className="text-sm text-text-muted">You have unsaved changes.</p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => { setDraft(saved.data ?? null); setIssues([]); }}>Discard</Button>
              <Button onClick={() => save.mutate(c)} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save changes'}</Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
