// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { type Language, LANGUAGES, normalise, PACKS } from './locales';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const e164 = z.string().regex(/^\+[1-9]\d{7,14}$/, 'expected E.164, like +13035550100');

export const OpeningWindow = z.object({ open: hhmm, close: hhmm })
  .refine((w) => w.open < w.close, 'a window must close after it opens');

/** 0 = Sunday. A missing or empty day is closed. */
export const WeeklyHours = z.partialRecord(z.enum(['0', '1', '2', '3', '4', '5', '6']), z.array(OpeningWindow));

export const LanguageSchema = z.enum(LANGUAGES);

/** What a provider or a visit type is called in another language, when the clinic says it differently. */
const LocalNames = z.partialRecord(LanguageSchema, z.string().min(1).max(80));

/** A person's gender as a clinic records it. undisclosed: they preferred not to say. */
export const GENDERS = ['female', 'male', 'other', 'undisclosed'] as const;
export const Gender = z.enum(GENDERS);
export type Gender = z.infer<typeof Gender>;
/** "female", "male", "other", "prefers not to say": how the assistant and the screens say it. */
export const genderWord = (g: Gender) => (g === 'undisclosed' ? 'prefers not to say' : g);

/** Whole days a provider is away: leave, a conference, a day off. Both ends included. */
export const TimeOff = z.object({ from: isoDate, to: isoDate, note: z.string().trim().max(80).optional() })
  .refine((t) => t.from <= t.to, 'time off must end on or after the day it starts');

/** The ages a provider sees, in whole years. No upper limit means every age from `min`. */
export const AgeRange = z.object({ min: z.number().int().min(0).max(120), max: z.number().int().min(0).max(120).nullable() })
  .refine((a) => a.max === null || a.max >= a.min, 'the oldest age must be at least the youngest');

export const Provider = z.object({
  // loose here, so a configuration saved by an older version still loads and calls keep running;
  // a doctor added or changed now is held to DoctorInput's stricter rules
  id: z.string(),
  name: z.string(),
  names: LocalNames.optional(),
  // a person ("with Dr. Rahman") or a room ("in the sample collection room"): read-backs say it properly
  kind: z.enum(['person', 'room']).default('person'),
  // so a caller who asks for a female or a male doctor is offered one; absent on configurations saved before v0.5.1
  gender: Gender.optional(),
  // what callers and staff hear about them: "Family medicine", "Pediatrics"
  specialty: z.string().trim().max(60).optional(),
  // what they see people for, a few words each: "Children", "Women's health", "Diabetes care"
  categories: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  // who they see; absent means every age
  ages: AgeRange.optional(),
  // a new patient is only offered providers who take new patients
  acceptingNewPatients: z.boolean().default(true),
  // the provider's own bookable hours; falls back to the clinic's hours when absent
  hours: WeeklyHours.optional(),
  timeOff: z.array(TimeOff).max(100).default([]),
  visitTypeIds: z.array(z.string()).min(1),
});

export const VisitType = z.object({
  id: z.string(),
  name: z.string(), // "new patient visit", said to callers as written
  names: LocalNames.optional(), // the same, in another language: { es: 'consulta por enfermedad' }
  minutes: z.number().int().min(5).max(240),
  // who may book it: everyone, only new patients ("new patient visit") or only patients already on file
  audience: z.enum(['all', 'new', 'existing']).default('all'),
});

export const TransferTarget = z.enum(['front_desk', 'billing', 'on_call']);
export type TransferTarget = z.infer<typeof TransferTarget>;

export const RoutingRule = z.object({
  target: TransferTarget,
  // tel:+1... or sip:... ; validated as a URI the SIP refer can use
  uri: z.string().regex(/^(tel:\+[1-9]\d{7,14}|sips?:[^\s]+)$/),
  when: z.enum(['open', 'closed', 'always']),
  priority: z.number().int().default(0),
});

export const Faq = z.object({
  id: z.string(),
  question: z.string(),
  answer: z.string().max(600),
});

const ClinicConfigShape = z.object({
  id: z.string(),
  name: z.string(),
  timezone: z.string().refine((tz) => {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
  }, 'unknown IANA time zone'),
  phoneNumbers: z.array(e164).min(1),
  hours: WeeklyHours,
  holidays: z.array(isoDate).default([]),
  // callers must know they are talking to software; the greeting has to say so (checked below, in the clinic's languages)
  greeting: z.string().max(400),
  // a first name the assistant introduces itself with ("Maya"); without one it is "the clinic's assistant"
  assistantName: z.string().trim().regex(/^[\p{L}\p{M}]{2,24}$/u, 'the assistant name is one word of 2 to 24 letters').optional(),
  // the languages the assistant speaks on this clinic's calls; the primary one is spoken first
  languages: z.array(LanguageSchema).min(1).default(['en']),
  primaryLanguage: LanguageSchema.default('en'),
  // the number the emergency script tells callers to ring; defaults from the clinic's country (911, 999)
  emergencyNumber: z.string().regex(/^\d{2,4}$/, 'an emergency number is 2 to 4 digits, like 911 or 999').optional(),
  voice: z.string().default('marin'),
  providers: z.array(Provider).min(1),
  visitTypes: z.array(VisitType).min(1),
  routing: z.array(RoutingRule).default([]),
  faqs: z.array(Faq).default([]),
  emergencyTransferEnabled: z.boolean().default(false),
  // transcripts and call summaries older than this are deleted; about 7 years by default, as many US states keep records
  retentionDays: z.number().int().min(30, 'keep call records for at least 30 days').max(3650, 'at most 10 years').default(2555),
  recording: z.object({ enabled: z.boolean(), notice: z.string().optional() })
    .default({ enabled: false })
    .refine((r) => !r.enabled || !!r.notice, 'recording needs a notice that plays before the call is recorded'),
}).superRefine((c, ctx) => {
  if (!c.languages.includes(c.primaryLanguage)) {
    ctx.addIssue({ code: 'custom', path: ['languages'], message: 'the primary language must be one of the languages the assistant speaks' });
  }
  if (new Set(c.languages).size !== c.languages.length) ctx.addIssue({ code: 'custom', path: ['languages'], message: 'a language is listed twice' });
  // ids are what bookings and the assistant refer to, so each one names exactly one thing
  const dupe = (ids: string[]) => ids.find((id, i) => ids.indexOf(id) !== i);
  const provider = dupe(c.providers.map((p) => p.id));
  if (provider) ctx.addIssue({ code: 'custom', path: ['providers'], message: `two providers have the id ${provider}` });
  const visit = dupe(c.visitTypes.map((v) => v.id));
  if (visit) ctx.addIssue({ code: 'custom', path: ['visitTypes'], message: `two visit types have the id ${visit}` });

  // A name is never a disclosure: "Hi, I'm Maya" sounds like a person. The greeting
  // must say AI assistant (or the same in one of the clinic's languages) whatever the
  // assistant is called.
  const greeting = normalise(c.greeting);
  if (!c.languages.some((l) => PACKS[l].disclosure.test(greeting))) {
    ctx.addIssue({ code: 'custom', path: ['greeting'], message: 'the greeting must disclose that the caller is speaking with an AI assistant' });
  }
});

const isLanguage = (v: unknown): v is Language => typeof v === 'string' && (LANGUAGES as readonly string[]).includes(v);
const knownNames = (names: unknown) => (names && typeof names === 'object' ? Object.fromEntries(Object.entries(names).filter(([k]) => isLanguage(k))) : names);

/**
 * A configuration saved with a language Attendra no longer ships still loads, so its
 * calls keep running: the language is dropped from the list and from local names,
 * the primary language moves to one still offered, and if the greeting only
 * disclosed the AI in the dropped language, the primary language's own greeting
 * takes its place. Everything else is checked as usual.
 */
function withoutRetiredLanguages(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const c = { ...(raw as Record<string, unknown>) };
  for (const key of ['providers', 'visitTypes'] as const) {
    if (Array.isArray(c[key])) c[key] = (c[key] as Record<string, unknown>[]).map((x) => (x && typeof x === 'object' && 'names' in x ? { ...x, names: knownNames(x.names) } : x));
  }
  const listed = Array.isArray(c.languages) ? (c.languages as unknown[]) : null;
  const retired = !!listed?.some((l) => !isLanguage(l)) || (c.primaryLanguage !== undefined && !isLanguage(c.primaryLanguage));
  if (!retired) return c;
  const languages = (listed ?? ['en']).filter(isLanguage);
  c.languages = languages.length ? languages : ['en'];
  const offered = c.languages as Language[];
  if (!isLanguage(c.primaryLanguage) || !offered.includes(c.primaryLanguage)) c.primaryLanguage = offered[0];
  const greeting = typeof c.greeting === 'string' ? normalise(c.greeting) : '';
  if (!offered.some((l) => PACKS[l].disclosure.test(greeting))) {
    c.greeting = PACKS[c.primaryLanguage as Language].greeting({ assistantName: typeof c.assistantName === 'string' ? c.assistantName : null, clinicName: String(c.name ?? '') });
  }
  return c;
}

export const ClinicConfig = z.preprocess(withoutRetiredLanguages, ClinicConfigShape);
export type ClinicConfig = z.infer<typeof ClinicConfig>;

/**
 * Things worth fixing that do not stop a configuration from being saved or a call
 * from running, shown in Settings. The software's name is not the clinic's, and
 * callers should not hear it; but a clinic may be called something like it, so
 * this is a warning, never a reason ClinicConfig.parse fails and calls stop.
 */
export function clinicWarnings(c: Pick<ClinicConfig, 'greeting' | 'assistantName'>): { path: 'greeting' | 'assistantName'; message: string }[] {
  const out: { path: 'greeting' | 'assistantName'; message: string }[] = [];
  if (/attendra/i.test(c.greeting)) out.push({ path: 'greeting', message: 'The greeting names the software. Callers should hear the clinic\'s name, not Attendra\'s.' });
  if (c.assistantName && /attendra/i.test(c.assistantName)) out.push({ path: 'assistantName', message: 'The assistant is named after the software. Callers should hear a name of the clinic\'s own.' });
  return out;
}
export type Provider = z.infer<typeof Provider>;

/**
 * Problems a change must not introduce, checked when doctors or settings are saved.
 * Not part of ClinicConfig itself, so a configuration saved by an older version that
 * has one still loads and its calls keep running.
 */
export function configProblems(c: Pick<z.infer<typeof ClinicConfigShape>, 'providers' | 'visitTypes'>): { path: string; message: string }[] {
  return c.providers.flatMap((p, i) => {
    const unknown = p.visitTypeIds.find((id) => !c.visitTypes.some((v) => v.id === id));
    return unknown ? [{ path: `providers.${i}.visitTypeIds`, message: `${p.name} offers a visit type that does not exist (${unknown})` }] : [];
  });
}
export type TimeOff = z.infer<typeof TimeOff>;
export type AgeRange = z.infer<typeof AgeRange>;
export type VisitType = z.infer<typeof VisitType>;
export type RoutingRule = z.infer<typeof RoutingRule>;

/** The name a provider or visit type is said with in a language, falling back to the clinic's own. */
export const localName = (thing: { name: string; names?: Partial<Record<Language, string>> }, language: Language) =>
  thing.names?.[language] ?? thing.name;
