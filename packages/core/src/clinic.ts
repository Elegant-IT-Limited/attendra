// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { INDUSTRIES } from './industries/types';
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
  // the stand-in a new clinic starts with, so a test call can book before the team adds its own; never offered once there is anyone else
  placeholder: z.boolean().optional(),
  // qualifications a caller may hear when they ask: "DVM", "Fear Free Certified", "Board-certified surgeon"
  credentials: z.array(z.string().trim().min(2).max(60)).max(8).optional(),
});

export const VisitType = z.object({
  id: z.string(),
  name: z.string(), // "new patient visit", said to callers as written
  names: LocalNames.optional(), // the same, in another language: { es: 'consulta por enfermedad' }
  minutes: z.number().int().min(5).max(240),
  // who may book it: everyone, only new patients ("new patient visit") or only patients already on file
  audience: z.enum(['all', 'new', 'existing']).default('all'),
  // what the assistant tells a caller who asks what it is or what it includes
  description: z.string().trim().max(300).optional(),
  // booked by the team only: the assistant takes a request instead of offering times
  staffOnly: z.boolean().optional(),
  // the assistant books it at least this many hours ahead (never under two hours)
  noticeHours: z.number().int().min(0).max(720).optional(),
  // the assistant books it at most this many days ahead
  maxDaysAhead: z.number().int().min(1).max(365).optional(),
  // free minutes the provider keeps after each one (cleaning, notes): for every booking, on calls and at the desk
  bufferMinutes: z.number().int().min(0).max(120).optional(),
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

/** Something the clinic is running now that callers may ask about: a vaccine clinic, a dental month. */
export const Offer = z.object({
  id: z.string(),
  title: z.string().trim().min(2).max(80),
  details: z.string().trim().min(2).max(400),
  from: isoDate.optional(),
  to: isoDate.optional(),
}).refine((o) => !o.from || !o.to || o.from <= o.to, 'an offer must end on or after the day it starts');

/** A kind of request the clinic wants taken its own way: boarding, grooming, insurance. What to ask is the clinic's words. */
export const RequestTopic = z.object({
  id: z.string(),
  name: z.string().trim().min(2).max(60),
  collect: z.string().trim().max(300).optional(),
});

/** A link the clinic adds to its own dashboard menu: its practice software, its booking page, a form. */
export const MenuLink = z.object({
  label: z.string().trim().min(1).max(30),
  url: z.string().trim().max(500).regex(/^https:\/\//, 'a link starts with https://'),
});

/** A detail the clinic keeps on each pet or patient that Attendra has no field for: microchip, insurer, a note. Staff fill it in. */
export const CustomField = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  label: z.string().trim().min(1).max(40),
  kind: z.enum(['text', 'yesno', 'date']),
});

/**
 * An emergency hospital the assistant sends an owner to. Without hours it is open
 * around the clock; with them, every day between open and close (a close earlier than
 * the open runs past midnight: 18:00 to 08:00 is overnight).
 */
export const EmergencyHospital = z.object({
  name: z.string().trim().min(2).max(80),
  phone: e164,
  address: z.string().trim().min(5).max(200),
  hours: z.object({ open: hhmm, close: hhmm }).optional(),
});
export type EmergencyHospital = z.infer<typeof EmergencyHospital>;

/** A caller the clinic always wants a person to answer: a partner vet, a breeder, the owner's family. */
export const VipCaller = z.object({
  name: z.string().trim().min(1).max(60),
  phone: e164,
});

export const Faq = z.object({
  id: z.string(),
  question: z.string(),
  answer: z.string().max(600),
});

const ClinicConfigShape = z.object({
  id: z.string(),
  name: z.string(),
  // where the clinic is and its website: the assistant gives them to a caller who asks
  address: z.string().trim().max(200).optional(),
  website: z.string().trim().max(200).regex(/^https?:\/\//, 'a website starts with https://').optional(),
  // the trade the assistant works in: what things are called and the prompt lines that depend on it
  industry: z.enum(INDUSTRIES).default('clinic'),
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
  emergencyNumber: z.string().regex(/^\d{2,5}$/, 'an emergency number is 2 to 5 digits, like 911 or 999').optional(),
  voice: z.string().default('marin'),
  providers: z.array(Provider).min(1),
  visitTypes: z.array(VisitType).min(1),
  routing: z.array(RoutingRule).default([]),
  faqs: z.array(Faq).default([]),
  // what the clinic is running now; the assistant answers from it when callers ask
  offers: z.array(Offer).max(20).optional(),
  // the clinic's own kinds of request: the assistant asks what each one needs and labels the request with it
  requestTopics: z.array(RequestTopic).max(20).optional(),
  // the clinic's own links in its dashboard menu, for everyone on the team
  menuLinks: z.array(MenuLink).max(8).optional(),
  // the clinic's own details on each pet or patient, filled in by staff on the record
  customFields: z.array(CustomField).max(20).optional(),
  // numbers that go straight to the front desk while it takes transfers
  vipCallers: z.array(VipCaller).max(50).optional(),
  emergencyTransferEnabled: z.boolean().default(false),
  // where the veterinary pack sends an animal in danger: the clinic's first choice of emergency hospital
  emergencyHospital: EmergencyHospital.optional(),
  // and its next choices, in order, for the hours the first one is closed or too far
  moreEmergencyHospitals: z.array(EmergencyHospital).max(4).optional(),
  // while the clinic is closed: book as usual, or take requests for the team to book in the morning
  afterHours: z.enum(['book', 'requests']).default('book'),
  // what a visit is worth on average, in the clinic's currency: the weekly report multiplies the bookings made after hours by it
  averageVisitValue: z.number().int().min(0).max(100_000).default(150),
  // the clinic's own review of the emergency lists: who reviewed them, when, and which version of the lists
  emergencyReview: z.object({
    reviewerName: z.string().trim().min(2).max(100),
    reviewerRole: z.string().trim().min(2).max(60),
    reviewedAt: z.iso.datetime(),
    version: z.string().regex(/^[0-9a-f]{8}$/),
  }).optional(),
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
  // a value on a record is kept under its field's id
  const field = dupe((c.customFields ?? []).map((f) => f.id));
  if (field) ctx.addIssue({ code: 'custom', path: ['customFields'], message: `two fields have the id ${field}` });

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
export function clinicWarnings(c: Pick<ClinicConfig, 'greeting' | 'assistantName'> & Partial<Pick<ClinicConfig, 'routing' | 'phoneNumbers'>>): { path: 'greeting' | 'assistantName' | 'routing'; message: string }[] {
  const out: { path: 'greeting' | 'assistantName' | 'routing'; message: string }[] = [];
  if (/attendra/i.test(c.greeting)) out.push({ path: 'greeting', message: 'The greeting names the software. Callers should hear the clinic\'s name, not Attendra\'s.' });
  if (c.assistantName && /attendra/i.test(c.assistantName)) out.push({ path: 'assistantName', message: 'The assistant is named after the software. Callers should hear a name of the clinic\'s own.' });
  // a transfer to a line that is forwarded to the assistant comes straight back to the assistant
  const own = new Set((c.phoneNumbers ?? []).map((n) => n.replace(/\D/g, '').slice(-10)));
  const loop = (c.routing ?? []).find((r) => r.uri.startsWith('tel:') && own.has(r.uri.replace(/\D/g, '').slice(-10)));
  if (loop) out.push({ path: 'routing', message: `A transfer number (${loop.uri.slice(4)}) is a number this clinic answers with the assistant. A caller sent there would come straight back to the assistant. Use a direct line or a mobile that a person answers.` });
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
export type CustomField = z.infer<typeof CustomField>;
export type RoutingRule = z.infer<typeof RoutingRule>;

/** The name a provider or visit type is said with in a language, falling back to the clinic's own. */
export const localName = (thing: { name: string; names?: Partial<Record<Language, string>> }, language: Language) =>
  thing.names?.[language] ?? thing.name;
