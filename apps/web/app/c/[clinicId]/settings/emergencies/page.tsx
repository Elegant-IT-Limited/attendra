// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { asE164, type ClinicConfig, countryCopy, emergencyCallLine, emergencyNumberFor, emergencyPreview, EmergencySettings, emergencySettingsOf, type EmergencyHospital, type EmergencyMode } from '@attendra/core';
import { useMutation } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Field, Section } from '@/components/settings/section';
import { SettingsNav } from '@/components/settings/settings-nav';
import { PageHeader } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { Checkbox, RadioGroup, Switch } from '@/components/ui/controls';
import { Alert, Skeleton } from '@/components/ui/feedback';
import { Input } from '@/components/ui/input';
import { PhoneInput } from '@/components/ui/phone-input';
import { useProblem, useToast } from '@/components/ui/toast';
import { ApiFailure, useClinic } from '@/lib/api';
import { DAYS } from '@/lib/format';
import { useSettingsSlice } from '@/lib/settings-save';

type Hospital = { name: string; phone: string; address: string };
type Hours = NonNullable<ClinicConfig['hours']>;
/** The form as it is typed: every mode's fields kept, so switching modes loses nothing. */
interface Draft { mode: EmergencyMode; hospital: Hospital; number: string; backupOn: boolean; backup: Hospital; ownHours: boolean; hours: Hours; afterHours: Hospital }

const blank = (): Hospital => ({ name: '', phone: '', address: '' });
const fromHospital = (h: EmergencyHospital | undefined | null): Hospital => (h ? { name: h.name, phone: h.phone, address: h.address } : blank());

function draftOf(c: ClinicConfig): Draft {
  const e = emergencySettingsOf(c);
  return {
    mode: e?.mode ?? 'refer',
    hospital: fromHospital(e?.mode === 'refer' ? e.hospital : c.emergencyHospital),
    number: e && e.mode !== 'refer' ? e.number : '',
    backupOn: e?.mode === 'handle' && !!e.backupHospital,
    backup: fromHospital(e?.mode === 'handle' ? e.backupHospital : c.emergencyHospital),
    ownHours: e?.mode === 'hours' && !!e.hours,
    hours: (e?.mode === 'hours' && e.hours) || c.hours,
    afterHours: fromHospital(e?.mode === 'hours' ? e.afterHoursHospital : c.emergencyHospital),
  };
}

/** The setting the draft makes, as saved. Zod's answer says what is missing, so Save waits until the mode is complete. */
function settingOf(d: Draft) {
  const h = (x: Hospital) => ({ name: x.name.trim(), phone: x.phone, address: x.address.trim() });
  const raw = d.mode === 'refer' ? { mode: 'refer', hospital: h(d.hospital) }
    : d.mode === 'handle' ? { mode: 'handle', number: d.number, ...(d.backupOn ? { backupHospital: h(d.backup) } : {}) }
      : { mode: 'hours', number: d.number, afterHoursHospital: h(d.afterHours), ...(d.ownHours ? { hours: d.hours } : {}) };
  return EmergencySettings.safeParse(raw);
}

const MODES: { value: EmergencyMode; label: string; hint: string }[] = [
  { value: 'refer', label: 'Refer emergencies to a hospital', hint: 'Callers whose animal is in danger are sent to your emergency hospital, at any hour, and can have its address texted.' },
  { value: 'handle', label: 'We handle emergencies, any time (on call)', hint: 'Callers are put through live to your emergency line: the clinic\'s, or an on-call mobile. A backup hospital is optional, for when nobody answers.' },
  { value: 'hours', label: 'We handle emergencies in these hours, refer after', hint: 'In your emergency hours callers are put through to your team; outside them, and on holidays and special days, they are sent to your after-hours hospital.' },
];

/**
 * Settings > Emergencies (batch 1b): how this location handles an animal's emergency, and what callers will hear. The
 * preview and the test-call line come from the same emergencyRoute the assistant follows on calls.
 */
export default function EmergencySettingsPage() {
  const { clinicId } = useParams<{ clinicId: string }>();
  const { can } = useClinic(clinicId);
  const toast = useToast();
  const problem = useProblem();
  const slice = useSettingsSlice(clinicId);
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => { if (slice.config && !draft) setDraft(draftOf(slice.config)); }, [slice.config, draft]);
  const now = useMemo(() => new Date(), []);

  const save = useMutation({
    mutationFn: (emergencies: EmergencySettings) => slice.save({ emergencies }),
    onSuccess: (config: ClinicConfig) => { setDraft(draftOf(config)); toast({ tone: 'success', message: 'Saved. The next call follows this setting.' }); },
    onError: (e) => problem(e instanceof ApiFailure
      ? { title: 'Not saved. Fix these first', items: (e.body.issues ?? [{ path: '', message: e.message }]).map((i) => i.message) }
      : { title: 'Not saved', message: 'The changes did not reach the server. Check your connection and press Save changes again.' }),
  });

  if (slice.isError) return <><PageHeader title="Settings" /><SettingsNav clinicId={clinicId} /><Alert tone="danger">The settings did not load. Refresh the page.</Alert></>;
  if (!draft || !slice.config) return <><PageHeader title="Settings" /><SettingsNav clinicId={clinicId} /><Skeleton className="h-96" /></>;
  const c = slice.config;
  const writable = can('settings:write');
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const setting = settingOf(draft);
  const saved = emergencySettingsOf(c);
  const dirty = !setting.success || JSON.stringify(setting.data) !== JSON.stringify(saved);
  const missing = setting.success ? [] : [...new Set(setting.error.issues.map((i) => labelFor(i.path.map(String))))];
  // what callers will hear with the draft as it stands (the saved setting until it is complete)
  const preview = { ...c, emergencies: setting.success ? setting.data : saved ?? undefined };
  const number = emergencyNumberFor(c, 'en');

  const hospitalFields = (id: string, h: Hospital, onChange: (h: Hospital) => void) => (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Hospital name" htmlFor={`${id}-name`}><Input id={`${id}-name`} maxLength={80} value={h.name} placeholder="e.g. City Pet Emergency" onChange={(e) => onChange({ ...h, name: e.target.value })} /></Field>
        <Field label="Phone" hint="As you would dial it." htmlFor={`${id}-phone`}><PhoneInput id={`${id}-phone`} value={h.phone} autoComplete="off" placeholder={countryCopy(c).phone.local || countryCopy(c).phone.e164} onValue={(phone) => onChange({ ...h, phone })} onBlur={(e) => onChange({ ...h, phone: asE164(c, e.target.value) })} /></Field>
      </div>
      <Field label="Address" hint="Read to callers as written." htmlFor={`${id}-address`}><Input id={`${id}-address`} maxLength={200} value={h.address} placeholder="e.g. 1200 Main Street, Denver" onChange={(e) => onChange({ ...h, address: e.target.value })} /></Field>
    </div>
  );
  const line = (
    <Field label="Emergency line" hint="The clinic's line or an on-call mobile that a person answers. Callers are put through to it live." htmlFor="emergency-number">
      <PhoneInput id="emergency-number" value={draft.number} autoComplete="off" placeholder={countryCopy(c).phone.local || countryCopy(c).phone.e164} onValue={(n) => set({ number: n })} onBlur={(e) => set({ number: asE164(c, e.target.value) })} />
    </Field>
  );

  return (
    <>
      <PageHeader title="Settings" description="What the assistant says, when the clinic is open, and what it can book. Changes apply to the next call." />
      <SettingsNav clinicId={clinicId} />
      {!writable && <Alert className="mb-6">You can read these settings. A practice manager or owner can change them.</Alert>}
      <Alert className="mb-6" title="Right now">{emergencyCallLine(preview, now)}</Alert>
      <fieldset disabled={!writable || save.isPending} className="min-w-0 space-y-6 pb-24">
        <Section id="mode" title="How this location handles emergencies" description={`When a caller describes an animal in danger, the assistant asks once whether it is still an emergency. On a yes or "not sure" it follows this setting. On a clear no it books as usual, with a note for your team. A person in danger is always told to call ${number}.`}>
          <RadioGroup label="How this location handles emergencies" value={draft.mode} onValueChange={(mode) => set({ mode })} options={MODES} />
        </Section>

        {draft.mode === 'refer' && (
          <Section id="hospital" title="Emergency hospital" description="Where callers are sent, with its address and phone. Required.">
            {hospitalFields('hospital', draft.hospital, (hospital) => set({ hospital }))}
          </Section>
        )}

        {draft.mode === 'handle' && (
          <Section id="line" title="Emergency line" description="Required. Callers are put through to it at any hour.">
            {line}
            <Switch id="backup-on" label="A backup hospital" hint="Only for a caller who can't wait when nobody answers the line. Optional." checked={draft.backupOn} onCheckedChange={(backupOn) => set({ backupOn })} />
            {draft.backupOn && hospitalFields('backup', draft.backup, (backup) => set({ backup }))}
          </Section>
        )}

        {draft.mode === 'hours' && (
          <>
            <Section id="line" title="Emergency line and hours" description="Required. In these hours callers are put through to your team; holidays and special days count as closed.">
              {line}
              <Switch id="own-hours" label="Emergency hours other than our opening hours" checked={draft.ownHours} onCheckedChange={(ownHours) => set({ ownHours })}
                hint="Off: your opening hours, under General." />
              {draft.ownHours && <HoursRows hours={draft.hours} onChange={(hours) => set({ hours })} />}
            </Section>
            <Section id="after" title="After-hours hospital" description="Where callers are sent outside your emergency hours. Required.">
              {hospitalFields('after', draft.afterHours, (afterHours) => set({ afterHours }))}
            </Section>
          </>
        )}

        <Section id="preview" title="What callers will hear" description="Word for word, with your emergency hours open and closed. Luna is a made-up pet.">
          <div className="grid gap-4 lg:grid-cols-2">
            {(['en', 'es'] as const).map((lang) => [true, false].map((open) => {
              const p = emergencyPreview(preview, lang, open, now);
              return (
                <div key={`${lang}-${open}`} className="rounded-md border border-border p-4 text-sm" data-testid={`preview-${lang}-${open ? 'open' : 'closed'}`}>
                  <p className="mb-2 font-medium">{lang === 'en' ? 'English' : 'Spanish'} · {open ? 'open' : 'closed'}</p>
                  <dl className="space-y-2">
                    <div><dt className="text-text-muted">The one question</dt><dd>"{p.question}"</dd></div>
                    <div><dt className="text-text-muted">On a yes or "not sure"</dt><dd>"{p.yes}"</dd></div>
                    {p.transferFailed && <div><dt className="text-text-muted">If nobody answers</dt><dd>"{p.transferFailed}"</dd></div>}
                    <div><dt className="text-text-muted">On a clear no</dt><dd>"{p.clearNo}"</dd></div>
                  </dl>
                </div>
              );
            }))}
          </div>
        </Section>
      </fieldset>

      {writable && dirty && (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-surface/95 backdrop-blur md:left-16 xl:left-60">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 md:px-8">
            <p className="text-sm text-text-muted">{missing.length ? `Still needed: ${missing.join(', ')}.` : 'You have unsaved changes.'}</p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setDraft(draftOf(c))}>Discard</Button>
              <Button onClick={() => setting.success && save.mutate(setting.data)} disabled={save.isPending || !setting.success}>{save.isPending ? 'Saving…' : 'Save changes'}</Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** What a missing or wrong field is called on this page. */
function labelFor(path: string[]): string {
  const [first, field] = path;
  const where = first === 'hospital' ? 'the hospital\'s' : first === 'backupHospital' ? 'the backup hospital\'s' : first === 'afterHoursHospital' ? 'the after-hours hospital\'s' : '';
  if (first === 'number') return 'the emergency line';
  if (first === 'hours') return 'the emergency hours';
  return `${where} ${field ?? 'details'}`.trim();
}

/** The emergency hours, day by day: closed, or open between two times. */
function HoursRows({ hours, onChange }: { hours: Hours; onChange: (h: Hours) => void }) {
  return (
    <div className="space-y-2">
      {DAYS.map((day, i) => {
        const key = String(i) as keyof Hours;
        const w = hours[key]?.[0];
        return (
          <div key={day} className="flex flex-wrap items-center gap-2 text-sm">
            <Checkbox id={`day-${i}`} label={day} checked={!!w} onCheckedChange={(on) => onChange({ ...hours, [key]: on ? [{ open: '08:00', close: '18:00' }] : [] })} />
            {w && (
              <>
                <Input type="time" aria-label={`${day} from`} className="w-32" value={w.open} onChange={(e) => onChange({ ...hours, [key]: [{ ...w, open: e.target.value }] })} />
                <span className="text-text-muted">to</span>
                <Input type="time" aria-label={`${day} to`} className="w-32" value={w.close} onChange={(e) => onChange({ ...hours, [key]: [{ ...w, close: e.target.value }] })} />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
