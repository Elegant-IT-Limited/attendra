// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { type ClinicConfig, type EmergencyHospital, emergencyHospitalsOf, EMERGENCY_MODES, type EmergencyMode, EmergencySettings, MORE_HOSPITALS_MAX } from './clinic';
import { type CallLinePlace, emergencyCallLine, emergencyPreview, emergencySettingsOf } from './emergency-route';
import { emergencyNumberFor, type Language } from './locales';
import { asE164 } from './phones';

/**
 * The emergency form, one source for both pages that show it (batch 1e): Settings > Emergencies in the dashboard, and
 * step 3 of the hosted setup page, which reads all of this from the engine (GET /clinics/:id/settings/emergencies) and
 * checks a draft with it (POST .../settings/emergencies/preview). The choices, every label and hint, the required fields
 * (the EmergencySettings schema), what a missing field is called, and the "what callers will hear" preview.
 */
export const EMERGENCY_CHOICES: readonly { value: EmergencyMode; label: string; hint: string }[] = [
  { value: 'refer', label: 'Refer emergencies to a hospital', hint: 'Callers whose animal is in danger are sent to your emergency hospital, at any hour, and can have its address texted.' },
  { value: 'handle', label: 'We handle emergencies, any time (on call)', hint: 'Callers are put through live to your emergency line: the clinic\'s, or an on-call mobile. A backup hospital is optional, for when nobody answers.' },
  { value: 'hours', label: 'We handle emergencies in these hours, refer after', hint: 'In your emergency hours callers are put through to your team; outside them, and on holidays and special days, they are sent to your after-hours hospital.' },
];

/** Every other word on the form, plain strings only, so the engine can serve them as they are. */
export const EMERGENCY_WORDING = {
  modeTitle: 'How this location handles emergencies',
  rightNow: 'Right now',
  stillNeeded: 'Still needed:',
  sections: {
    hospital: { title: 'Emergency hospital', description: 'Where callers are sent, with its address and phone. Required.' },
    line: { title: 'Emergency line', description: 'Required. Callers are put through to it at any hour.' },
    lineAndHours: { title: 'Emergency line and hours', description: 'Required. In these hours callers are put through to your team; holidays and special days count as closed.' },
    after: { title: 'After-hours hospital', description: 'Where callers are sent outside your emergency hours. Required.' },
    more: { title: 'More hospitals, in order', description: `Optional, up to ${MORE_HOSPITALS_MAX}. The assistant names the first hospital open at that moment: the one above, then these in order.`, add: 'Hospital', empty: 'No more hospitals. Add one for the hours your first choice is closed.' },
  },
  backup: { label: 'A backup hospital', hint: 'Only for a caller who can\'t wait when nobody answers the line. Optional.' },
  ownHours: { label: 'Emergency hours other than our opening hours', hint: 'Off: your opening hours, under General.' },
  fields: {
    name: { label: 'Hospital name', placeholder: 'e.g. City Pet Emergency' },
    phone: { label: 'Phone', hint: 'As you would dial it.' },
    address: { label: 'Address', hint: 'Read to callers as written.', placeholder: 'e.g. 1200 Main Street, Denver' },
    allDay: { label: 'Open 24 hours', hint: 'Turn off for a hospital that only takes emergencies part of the day, like evenings and nights.' },
    hospitalHours: { from: 'Every day from', to: 'to', note: 'A closing time before the opening time runs past midnight.' },
    line: { label: 'Emergency line', hint: 'The clinic\'s line or an on-call mobile that a person answers. Callers are put through to it live.' },
  },
  /** On the setup page, which edits the required fields only. */
  moreInSettings: 'More hospitals, in order, can be added under Settings > Emergencies.',
  preview: {
    title: 'What callers will hear',
    description: 'Word for word, with your emergency hours open and closed. Luna is a made-up pet.',
    question: 'The one question', yes: 'On a yes or "not sure"', transferFailed: 'If nobody answers', clearNo: 'On a clear no',
    languages: { en: 'English', es: 'Spanish' }, open: 'open', closed: 'closed',
  },
} as const;

/** The form's opening words, with the clinic's public emergency number (911). */
export const emergencyIntro = (emergencyNumber: string) => `When a caller describes an animal in danger, the assistant asks once whether it is still an emergency. On a yes or "not sure" it follows this setting. On a clear no it books as usual, with a note for your team. A person in danger is always told to call ${emergencyNumber}.`;

/** The fields' limits, as the schema has them (EmergencyHospital), for the inputs' maxLength. */
export const EMERGENCY_LIMITS = { name: { min: 2, max: 80 }, address: { min: 5, max: 200 }, moreHospitals: MORE_HOSPITALS_MAX } as const;

/** A hospital as it is typed: hours null when it is open around the clock. */
export const EmergencyHospitalDraft = z.object({
  name: z.string().max(500),
  phone: z.string().max(60),
  address: z.string().max(1000),
  hours: z.object({ open: z.string().max(5), close: z.string().max(5) }).nullable().default(null),
});
export type EmergencyHospitalDraft = z.infer<typeof EmergencyHospitalDraft>;
const blankHospital = (): EmergencyHospitalDraft => ({ name: '', phone: '', address: '', hours: null });

/**
 * The form as it is typed: every mode's fields kept, so switching modes loses nothing. Loose on purpose (an unfinished
 * draft is still a draft); what it must have to be saved is the EmergencySettings schema's answer.
 */
export const EmergencyDraft = z.object({
  mode: z.enum(EMERGENCY_MODES),
  hospital: EmergencyHospitalDraft,
  number: z.string().max(60),
  backupOn: z.boolean(),
  backup: EmergencyHospitalDraft,
  ownHours: z.boolean(),
  hours: z.record(z.string(), z.array(z.object({ open: z.string().max(5), close: z.string().max(5) })).max(4)),
  afterHours: EmergencyHospitalDraft,
  moreHospitals: z.array(EmergencyHospitalDraft).max(MORE_HOSPITALS_MAX).default([]),
});
export type EmergencyDraft = z.infer<typeof EmergencyDraft>;

const draftHospital = (h: EmergencyHospital | undefined | null): EmergencyHospitalDraft => (h ? { name: h.name, phone: h.phone, address: h.address, hours: h.hours ?? null } : blankHospital());

/** The draft for the saved setting. A mode not chosen starts from the setting's own hospital, so switching keeps it. */
export function emergencyDraftOf(c: Pick<ClinicConfig, 'emergencies' | 'hours'>): EmergencyDraft {
  const e = emergencySettingsOf(c);
  const [first] = emergencyHospitalsOf(e);
  return {
    mode: e?.mode ?? 'refer',
    hospital: draftHospital(e?.mode === 'refer' ? e.hospital : first),
    number: e && e.mode !== 'refer' ? e.number : '',
    backupOn: e?.mode === 'handle' && !!e.backupHospital,
    backup: draftHospital(e?.mode === 'handle' ? e.backupHospital : first),
    ownHours: e?.mode === 'hours' && !!e.hours,
    hours: ((e?.mode === 'hours' && e.hours) || c.hours) as EmergencyDraft['hours'],
    afterHours: draftHospital(e?.mode === 'hours' ? e.afterHoursHospital : first),
    moreHospitals: (e?.moreHospitals ?? []).map(draftHospital),
  };
}

/**
 * The setting the draft makes, as saved, checked by the schema: Save waits until the chosen mode is complete. With the
 * clinic, every phone is read in its country first ("(303) 555-0188" is +13035550188), as Settings' phone fields do.
 */
export function emergencySettingOf(d: EmergencyDraft, clinic?: Pick<ClinicConfig, 'phoneNumbers'>) {
  const phone = (n: string) => (clinic && n.trim() ? asE164(clinic, n) : n);
  const h = (x: EmergencyHospitalDraft) => ({ name: x.name.trim(), phone: phone(x.phone), address: x.address.trim(), ...(x.hours ? { hours: x.hours } : {}) });
  const more = d.moreHospitals.length ? { moreHospitals: d.moreHospitals.map(h) } : {};
  const raw = d.mode === 'refer' ? { mode: 'refer', hospital: h(d.hospital), ...more }
    : d.mode === 'handle' ? { mode: 'handle', number: phone(d.number), ...(d.backupOn ? { backupHospital: h(d.backup) } : {}), ...(d.backupOn ? more : {}) }
      : { mode: 'hours', number: phone(d.number), afterHoursHospital: h(d.afterHours), ...(d.ownHours ? { hours: d.hours } : {}), ...more };
  return EmergencySettings.safeParse(raw);
}

/** What a missing or wrong field is called on the form ("the hospital's phone"), by its path in the setting. */
export function emergencyFieldLabel(path: readonly (string | number)[]): string {
  const [first, second, third] = path.map(String);
  if (first === 'number') return 'the emergency line';
  if (first === 'hours') return 'the emergency hours';
  if (first === 'moreHospitals') return `more hospital ${Number(second ?? 0) + 1}'s ${third ?? 'details'}`;
  const where = first === 'hospital' ? 'the hospital\'s' : first === 'backupHospital' ? 'the backup hospital\'s' : first === 'afterHoursHospital' ? 'the after-hours hospital\'s' : '';
  return `${where} ${second ?? 'details'}`.trim();
}

/** The draft's problems, each once, by what the form calls the field. Empty when it can be saved. */
export function emergencyDraftIssues(d: EmergencyDraft, clinic?: Pick<ClinicConfig, 'phoneNumbers'>): string[] {
  const r = emergencySettingOf(d, clinic);
  return r.success ? [] : [...new Set(r.error.issues.map((i) => emergencyFieldLabel(i.path as (string | number)[])))];
}

type PreviewClinic = Parameters<typeof emergencyCallLine>[0] & Parameters<typeof emergencyPreview>[0];
export type EmergencyPreviewLines = ReturnType<typeof emergencyPreview>;

/**
 * What both pages show for a draft: its problems, the setting it makes (null until complete), the "Right now" line, and
 * what callers will hear in each language with the emergency hours open and closed (the saved setting until the draft
 * is complete, as Settings does).
 */
export function emergencyFormView(clinic: PreviewClinic & Pick<ClinicConfig, 'phoneNumbers'>, d: EmergencyDraft, now: Date, place: CallLinePlace = 'settings') {
  const r = emergencySettingOf(d, clinic);
  const shown = { ...clinic, emergencies: r.success ? r.data : emergencySettingsOf(clinic) ?? undefined };
  const preview = Object.fromEntries((['en', 'es'] as const satisfies readonly Language[]).map((lang) => [lang, {
    open: emergencyPreview(shown, lang, true, now),
    closed: emergencyPreview(shown, lang, false, now),
  }])) as Record<'en' | 'es', { open: EmergencyPreviewLines; closed: EmergencyPreviewLines }>;
  return {
    issues: r.success ? [] : [...new Set(r.error.issues.map((i) => emergencyFieldLabel(i.path as (string | number)[])))],
    setting: r.success ? r.data : null,
    callLine: emergencyCallLine(shown, now, place),
    preview,
  };
}

/** Everything the setup page needs to draw the form, as the engine serves it: the same constants Settings reads. */
export function emergencyFormFor(c: Pick<ClinicConfig, 'emergencies' | 'hours' | 'emergencyNumber' | 'country' | 'phoneNumbers'>) {
  return {
    choices: EMERGENCY_CHOICES,
    wording: EMERGENCY_WORDING,
    intro: emergencyIntro(emergencyNumberFor(c, 'en')),
    limits: EMERGENCY_LIMITS,
    draft: emergencyDraftOf(c),
  };
}

