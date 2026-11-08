// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { asE164, type ClinicConfig, countryCopy, EMERGENCY_CHOICES, EMERGENCY_LIMITS, EMERGENCY_WORDING, type EmergencyDraft, emergencyDraftOf, type EmergencyHospitalDraft, emergencyFormView, emergencyIntro, emergencyNumberFor, EmergencySettings, emergencySettingsOf } from '@attendra/core';
import { useMutation } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { EmptyNote, Field, Item, Section } from '@/components/settings/section';
import { SettingsHeader } from '@/components/settings/settings-nav';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox, RadioGroup, Switch } from '@/components/ui/controls';
import { Alert, Skeleton } from '@/components/ui/feedback';
import { Input } from '@/components/ui/input';
import { PhoneInput } from '@/components/ui/phone-input';
import { moved, Sortable } from '@/components/ui/sortable';
import { useProblem, useToast } from '@/components/ui/toast';
import { ApiFailure, useClinic } from '@/lib/api';
import { DAYS } from '@/lib/format';
import { useSettingsSlice } from '@/lib/settings-save';

type Hours = EmergencyDraft['hours'];
const W = EMERGENCY_WORDING;
const blank = (): EmergencyHospitalDraft => ({ name: '', phone: '', address: '', hours: null });

/**
 * Settings > Emergencies (batch 1b): how this location handles an animal's emergency, its hospitals in order, and what
 * callers will hear. The ONLY place a vet clinic's emergency route is edited (batch 1e); the setup page's step reads the
 * same choices, wording, rules and preview from core through the engine. The preview and the test-call line come from
 * the same emergencyRoute the assistant follows on calls.
 */
export default function EmergencySettingsPage() {
  const { clinicId } = useParams<{ clinicId: string }>();
  const { can } = useClinic(clinicId);
  const toast = useToast();
  const problem = useProblem();
  const slice = useSettingsSlice(clinicId);
  const [draft, setDraft] = useState<EmergencyDraft | null>(null);
  useEffect(() => { if (slice.config && !draft) setDraft(emergencyDraftOf(slice.config)); }, [slice.config, draft]);
  const now = useMemo(() => new Date(), []);

  const save = useMutation({
    mutationFn: (emergencies: EmergencySettings) => slice.save({ emergencies }),
    onSuccess: (config: ClinicConfig) => { setDraft(emergencyDraftOf(config)); toast({ tone: 'success', message: 'Saved. The next call follows this setting.' }); },
    onError: (e) => problem(e instanceof ApiFailure
      ? { title: 'Not saved. Fix these first', items: (e.body.issues ?? [{ path: '', message: e.message }]).map((i) => i.message) }
      : { title: 'Not saved', message: 'The changes did not reach the server. Check your connection and press Save changes again.' }),
  });

  if (slice.isError) return <><SettingsHeader clinicId={clinicId} /><Alert tone="danger">The settings did not load. Refresh the page.</Alert></>;
  if (!draft || !slice.config) return <><SettingsHeader clinicId={clinicId} /><Skeleton className="h-96" /></>;
  const c = slice.config;
  const writable = can('settings:write');
  const set = (patch: Partial<EmergencyDraft>) => setDraft({ ...draft, ...patch });
  // the draft's problems, the setting it makes, the "Right now" line and the preview: the same view the setup page gets
  const view = emergencyFormView(c, draft, now);
  const saved = emergencySettingsOf(c);
  // changed from what is saved (a draft from the saved setting saves back the same one); a clinic with no setting yet
  // sees the form, not a "Still needed" bar, until it types
  const dirty = JSON.stringify(draft) !== JSON.stringify(emergencyDraftOf(c)) || (!!view.setting && JSON.stringify(view.setting) !== JSON.stringify(saved));
  const phonePlaceholder = countryCopy(c).phone.local || countryCopy(c).phone.e164;
  const hasHospital = draft.mode !== 'handle' || draft.backupOn;

  const hospitalFields = (id: string, h: EmergencyHospitalDraft, onChange: (h: EmergencyHospitalDraft) => void) => (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={W.fields.name.label} htmlFor={`${id}-name`}><Input id={`${id}-name`} maxLength={EMERGENCY_LIMITS.name.max} value={h.name} placeholder={W.fields.name.placeholder} onChange={(e) => onChange({ ...h, name: e.target.value })} /></Field>
        <Field label={W.fields.phone.label} hint={W.fields.phone.hint} htmlFor={`${id}-phone`}><PhoneInput id={`${id}-phone`} value={h.phone} autoComplete="off" placeholder={phonePlaceholder} onValue={(phone) => onChange({ ...h, phone })} onBlur={(e) => onChange({ ...h, phone: asE164(c, e.target.value) })} /></Field>
      </div>
      <Field label={W.fields.address.label} hint={W.fields.address.hint} htmlFor={`${id}-address`}><Input id={`${id}-address`} maxLength={EMERGENCY_LIMITS.address.max} value={h.address} placeholder={W.fields.address.placeholder} onChange={(e) => onChange({ ...h, address: e.target.value })} /></Field>
      <Switch id={`${id}-24h`} label={W.fields.allDay.label} hint={W.fields.allDay.hint} checked={!h.hours} onCheckedChange={(on) => onChange({ ...h, hours: on ? null : { open: '18:00', close: '08:00' } })} />
      {h.hours && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-text-muted">{W.fields.hospitalHours.from}</span>
          <Input type="time" aria-label={`${h.name || 'Hospital'} opens`} className="w-32" value={h.hours.open} onChange={(e) => onChange({ ...h, hours: { ...h.hours!, open: e.target.value } })} />
          <span className="text-text-muted">{W.fields.hospitalHours.to}</span>
          <Input type="time" aria-label={`${h.name || 'Hospital'} closes`} className="w-32" value={h.hours.close} onChange={(e) => onChange({ ...h, hours: { ...h.hours!, close: e.target.value } })} />
          <span className="text-xs text-text-muted">{W.fields.hospitalHours.note}</span>
        </div>
      )}
    </div>
  );
  const line = (
    <Field label={W.fields.line.label} hint={W.fields.line.hint} htmlFor="emergency-number">
      <PhoneInput id="emergency-number" value={draft.number} autoComplete="off" placeholder={phonePlaceholder} onValue={(n) => set({ number: n })} onBlur={(e) => set({ number: asE164(c, e.target.value) })} />
    </Field>
  );
  const more = draft.moreHospitals;
  const setMore = (moreHospitals: EmergencyHospitalDraft[]) => set({ moreHospitals });

  return (
    <>
      <SettingsHeader clinicId={clinicId} />
      {!writable && <Alert className="mb-6">You can read these settings. A practice manager or owner can change them.</Alert>}
      <Alert className="mb-6" title={W.rightNow}>{view.callLine}</Alert>
      <fieldset disabled={!writable || save.isPending} className="min-w-0 space-y-6 pb-24">
        <Section id="mode" title={W.modeTitle} description={emergencyIntro(emergencyNumberFor(c, 'en'))}>
          <RadioGroup label={W.modeTitle} value={draft.mode} onValueChange={(mode) => set({ mode })} options={EMERGENCY_CHOICES.map((x) => ({ ...x }))} />
        </Section>

        {draft.mode === 'refer' && (
          <Section id="hospital" title={W.sections.hospital.title} description={W.sections.hospital.description}>
            {hospitalFields('hospital', draft.hospital, (hospital) => set({ hospital }))}
          </Section>
        )}

        {draft.mode === 'handle' && (
          <Section id="line" title={W.sections.line.title} description={W.sections.line.description}>
            {line}
            <Switch id="backup-on" label={W.backup.label} hint={W.backup.hint} checked={draft.backupOn} onCheckedChange={(backupOn) => set({ backupOn })} />
            {draft.backupOn && hospitalFields('backup', draft.backup, (backup) => set({ backup }))}
          </Section>
        )}

        {draft.mode === 'hours' && (
          <>
            <Section id="line" title={W.sections.lineAndHours.title} description={W.sections.lineAndHours.description}>
              {line}
              <Switch id="own-hours" label={W.ownHours.label} hint={W.ownHours.hint} checked={draft.ownHours} onCheckedChange={(ownHours) => set({ ownHours })} />
              {draft.ownHours && <HoursRows hours={draft.hours} onChange={(hours) => set({ hours })} />}
            </Section>
            <Section id="after" title={W.sections.after.title} description={W.sections.after.description}>
              {hospitalFields('after', draft.afterHours, (afterHours) => set({ afterHours }))}
            </Section>
          </>
        )}

        {hasHospital && (
          <Section id="more" title={W.sections.more.title} description={W.sections.more.description}
            action={<Button type="button" size="sm" variant="outline" disabled={more.length >= EMERGENCY_LIMITS.moreHospitals} onClick={() => setMore([...more, blank()])}><Plus /> {W.sections.more.add}</Button>}>
            {more.length === 0 && <EmptyNote>{W.sections.more.empty}</EmptyNote>}
            <Sortable items={more} keyOf={(_h, i) => String(i)} label={(h) => h.name} disabled={!writable || save.isPending} onMove={(f, t) => setMore(moved(more, f, t))} className="space-y-5">
              {(h, i, handle) => (
                <Item handle={handle} id={`item-more-${i}`} removeLabel={`Remove ${h.name || 'this hospital'}`} onRemove={() => setMore(more.filter((_, j) => j !== i))}>
                  <div className="space-y-4">
                    <Badge tone="neutral">{`Choice ${i + 2}`}</Badge>
                    {hospitalFields(`more-${i}`, h, (next) => setMore(more.map((x, j) => (j === i ? next : x))))}
                  </div>
                </Item>
              )}
            </Sortable>
          </Section>
        )}

        <Section id="preview" title={W.preview.title} description={W.preview.description}>
          <div className="grid gap-4 lg:grid-cols-2">
            {(['en', 'es'] as const).map((lang) => (['open', 'closed'] as const).map((when) => {
              const p = view.preview[lang][when];
              return (
                <div key={`${lang}-${when}`} className="rounded-md border border-border p-4 text-sm" data-testid={`preview-${lang}-${when}`}>
                  <p className="mb-2 font-medium">{W.preview.languages[lang]} · {W.preview[when]}</p>
                  <dl className="space-y-2">
                    <div><dt className="text-text-muted">{W.preview.question}</dt><dd>"{p.question}"</dd></div>
                    <div><dt className="text-text-muted">{W.preview.yes}</dt><dd>"{p.yes}"</dd></div>
                    {p.transferFailed && <div><dt className="text-text-muted">{W.preview.transferFailed}</dt><dd>"{p.transferFailed}"</dd></div>}
                    <div><dt className="text-text-muted">{W.preview.clearNo}</dt><dd>"{p.clearNo}"</dd></div>
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
            <p className="text-sm text-text-muted">{view.issues.length ? `${W.stillNeeded} ${view.issues.join(', ')}.` : 'You have unsaved changes.'}</p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setDraft(emergencyDraftOf(c))}>Discard</Button>
              <Button onClick={() => view.setting && save.mutate(view.setting)} disabled={save.isPending || !view.setting}>{save.isPending ? 'Saving…' : 'Save changes'}</Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** The emergency hours, day by day: closed, or open between two times. */
function HoursRows({ hours, onChange }: { hours: Hours; onChange: (h: Hours) => void }) {
  return (
    <div className="space-y-2">
      {DAYS.map((day, i) => {
        const key = String(i);
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
