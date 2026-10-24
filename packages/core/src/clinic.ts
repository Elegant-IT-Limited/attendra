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
export const TimeOff = z.object({
  from: isoDate, to: isoDate, note: z.string().trim().max(80).optional(),
  // a part of one day only: away between these times
  start: hhmm.optional(), end: hhmm.optional(),
})
  .refine((t) => t.from <= t.to, 'time off must end on or after the day it starts')
  .refine((t) => (!t.start && !t.end) || (!!t.start && !!t.end && t.from === t.to && t.start < t.end), 'a part-day absence is one day, with a start before its end');

/** One date's own hours: a half day before a holiday, a training afternoon. No windows is closed all day. */
export const SpecialDay = z.object({
  date: isoDate,
  windows: z.array(OpeningWindow).max(4),
  // "Christmas Eve", "staff training"
  note: z.string().trim().max(60).optional(),
});
export type SpecialDay = z.infer<typeof SpecialDay>;

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
  // the clinic's own details on this doctor (Settings, Fields and lists)
  custom: z.record(z.string(), z.string().max(400)).optional(),
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
export const CUSTOM_FIELD_KINDS = ['text', 'number', 'yesno', 'date', 'choice', 'multi'] as const;
/** One choice a dropdown offers: a few words, never the separator multi-choice values are stored with. */
const FieldOption = z.string().trim().min(1).max(40).regex(/^[^|]*$/, 'an option cannot contain |');
export const CustomField = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  label: z.string().trim().min(1).max(40),
  kind: z.enum(CUSTOM_FIELD_KINDS),
  // a dropdown's choices, in the order shown; one (choice) or several (multi) are picked
  options: z.array(FieldOption).max(30).optional(),
  // staff must fill it in before the record's details are saved
  required: z.boolean().optional(),
  // shown as a column on the list page
  column: z.boolean().optional(),
}).superRefine((f, ctx) => {
  if ((f.kind === 'choice' || f.kind === 'multi') && (f.options?.length ?? 0) < 2) ctx.addIssue({ code: 'custom', path: ['options'], message: 'a dropdown needs at least two choices' });
  const seen = new Set<string>();
  for (const o of f.options ?? []) {
    const k = o.toLowerCase();
    if (seen.has(k)) ctx.addIssue({ code: 'custom', path: ['options'], message: `"${o}" is listed twice` });
    seen.add(k);
  }
});

/** A list the clinic keeps in order: specialties, what vets see, kinds of animal. */
export const ManagedList = z.array(z.string().trim().min(1).max(40)).max(60).refine((l) => new Set(l.map((x) => x.toLowerCase())).size === l.length, 'a value is listed twice');
export const LIST_NAMES = ['specialties', 'categories', 'species'] as const;
/** The kinds of animal a vet clinic starts with, until it keeps its own list. */
export const DEFAULT_SPECIES = ['Dog', 'Cat', 'Rabbit', 'Bird', 'Guinea pig', 'Ferret', 'Reptile', 'Horse'] as const;
export type ListName = (typeof LIST_NAMES)[number];

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

/** What the assistant may text a caller during a call, after a spoken yes; and the automatic change confirmations. */
export const TEXT_KINDS = ['change_confirmed', 'directions', 'hours', 'emergency_hospital', 'provider', 'answer', 'link'] as const;
export type TextKind = (typeof TEXT_KINDS)[number];

/** A link the clinic lets the assistant text: new-client paperwork, a price list, a form. */
export const TextLink = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  // what the text calls it: "New client form"
  label: z.string().trim().min(2).max(40),
  url: z.string().trim().max(300).regex(/^https:\/\//, 'a link starts with https://'),
  // when to offer it, in the clinic's words: "a new client asks about paperwork"
  when: z.string().trim().min(2).max(120),
});

// a link shortener hides where a link goes; US carriers filter texts that use one
const SHORTENER = /\b(bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|buff\.ly|rebrand\.ly|cutt\.ly|shorturl\.at)\b/i;
// the clinic's texts are registered for appointments and care (A2P): selling words would break that
const PROMO = /(\d+\s?%\s?off|\bdiscounts?\b|\bcoupons?\b|\bpromo(tion)?\s?codes?\b|\bsale\b|\blimited[- ]time\b|\bdeal of\b|\bbuy now\b)/i;
const textPart = (max: number) => z.string().trim().max(max)
  .refine((t) => !SHORTENER.test(t), 'no shortened links: carriers filter them')
  .refine((t) => !PROMO.test(t), 'no sales or offer wording: these texts are registered for appointments and care')
  .optional();
/** The clinic's own words in one text: a few words after its name, and one line before "Reply STOP". The rest is fixed. */
export const TextWording = z.object({ label: textPart(40), extra: textPart(100) });
export type TextWording = z.infer<typeof TextWording>;

export const Texting = z.object({
  // the switch for texts asked for on a call; a hosted clinic has it turned on when its texting registration is approved
  enabled: z.boolean().default(false),
  kinds: z.object({
    // a confirmation when a visit is moved or cancelled on the phone, sent without asking, like the booking one
    change_confirmed: z.boolean().default(true),
    directions: z.boolean().default(true),
    hours: z.boolean().default(true),
    emergency_hospital: z.boolean().default(true),
    provider: z.boolean().default(false),
    answer: z.boolean().default(true),
    link: z.boolean().default(true),
  }).default({ change_confirmed: true, directions: true, hours: true, emergency_hospital: true, provider: false, answer: true, link: true }),
  // the clinic's own map link; without one, a Google Maps search of the address
  mapUrl: z.string().trim().max(300).regex(/^https:\/\//, 'a link starts with https://').optional(),
  links: z.array(TextLink).max(10).default([]),
  // per text, per language: the clinic's few words; empty means the standard wording
  wording: z.record(z.string(), z.object({ en: TextWording.optional(), es: TextWording.optional() })).default({}),
  reminders: z.object({
    enabled: z.boolean().default(false),
    hoursBefore: z.number().int().min(2).max(168).default(24),
    // no texts between these clinic-local times; one that would fall in them goes out when they end, if still 2 hours before the visit
    quietFrom: hhmm.default('20:00'),
    quietTo: hhmm.default('08:00'),
    // after a booking, the assistant asks once whether the caller would like one
    askOnBooking: z.boolean().default(true),
  }).default({ enabled: false, hoursBefore: 24, quietFrom: '20:00', quietTo: '08:00', askOnBooking: true }),
});
export type Texting = z.infer<typeof Texting>;

/**
 * Who the assistant books with when the caller does not name anyone. A caller who asks
 * for someone (a name, a kind of doctor, a female or male doctor) is always offered only
 * them; these rules are for everyone else.
 */
export const BookingRules = z.object({
  // no one in mind: the pet's (or patient's) usual vet first, or the earliest time with anyone
  noPreference: z.enum(['usual_first', 'earliest']).default('usual_first'),
  // how many days ahead the usual vet is worth waiting for; past that, the earliest with anyone
  usualWithinDays: z.number().int().min(1).max(30).default(3),
  // several free at the same moment: the one with the fewest visits that day, or the order of the list
  tieBreak: z.enum(['fewest_visits', 'list_order']).default('fewest_visits'),
  // a veterinary clinic: only vets who list the pet's kind of animal (a vet who lists no animals sees every animal)
  matchAnimal: z.boolean().default(true),
});
export type BookingRules = z.infer<typeof BookingRules>;

/** How the assistant talks: a few lines in its instructions. The rules it follows are in code and do not change with these. */
export const TalkStyle = z.object({
  pace: z.enum(['relaxed', 'normal', 'brisk']).default('normal'),
  style: z.enum(['warm', 'efficient', 'professional']).default('efficient'), // the default a clinic sees is defaultTalkStyle(industry)
  // short acknowledgements ("Got it", "Sure, one moment") instead of silence
  acknowledgements: z.boolean().default(true),
});
export type TalkStyle = z.infer<typeof TalkStyle>;
/** How the assistant talks when the clinic has not chosen: warm at a veterinary clinic (owners want "oh, poor Biscuit"), efficient elsewhere. */
export const defaultTalkStyle = (industry: string | undefined): TalkStyle['style'] => (industry === 'vet' ? 'warm' : 'efficient');

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

/** The longest a clinic keeps call transcripts and summaries: three years. */
export const MAX_RETENTION_DAYS = 1095;
/** What a clinic can choose in Settings, Call records. */
export const RETENTION_CHOICES = [90, 180, 365, 730, 1095] as const;

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
  // who the assistant books with when the caller names nobody
  booking: BookingRules.optional(),
  // which voice engine answers: set by the operator (provisioning), never in Settings; absent is the deployment's default
  voiceEngine: z.enum(['gpt-live', 'gpt-realtime']).optional(),
  // days whose hours differ from the week's: shorter, or closed with a reason
  specialDays: z.array(SpecialDay).max(60).optional(),
  // callers must know they are talking to software; the greeting has to say so (checked below, in the clinic's languages)
  greeting: z.string().max(400),
  // the greeting in each other language the assistant speaks; absent: that language's suggested greeting
  greetings: z.partialRecord(LanguageSchema, z.string().trim().min(10).max(400)).optional(),
  // how it talks: pace, style, acknowledgements
  talk: TalkStyle.optional(),
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
  // and on each doctor or veterinarian, and each request
  providerFields: z.array(CustomField).max(20).optional(),
  requestFields: z.array(CustomField).max(20).optional(),
  // lists the clinic keeps in order; absent, they are what the records already say
  lists: z.object({ specialties: ManagedList.optional(), categories: ManagedList.optional(), species: ManagedList.optional() }).optional(),
  // texts during a call and change confirmations
  texting: Texting.optional(),
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
  // transcripts and call summaries older than this are deleted: a year by default, three at most (a longer value saved
  // before this limit is kept at three years); the medical record itself lives in the clinic's own system
  retentionDays: z.number().int().min(30, 'keep call records for at least 30 days').max(3650).default(365).transform((d) => Math.min(d, MAX_RETENTION_DAYS)),
  recording: z.object({ enabled: z.boolean(), notice: z.string().optional() })
    .default({ enabled: false })
    .refine((r) => !r.enabled || !!r.notice, 'recording needs a notice that plays before the call is recorded'),
}).superRefine((c, ctx) => {
  if (!c.languages.includes(c.primaryLanguage)) {
    ctx.addIssue({ code: 'custom', path: ['languages'], message: 'the primary language must be one of the languages the assistant speaks' });
  }
  if (new Set(c.languages).size !== c.languages.length) ctx.addIssue({ code: 'custom', path: ['languages'], message: 'a language is listed twice' });
  for (const d of c.specialDays ?? []) {
    if (c.holidays.includes(d.date)) ctx.addIssue({ code: 'custom', path: ['specialDays'], message: `${d.date} is both a holiday and a special day` });
    if (d.windows.some((w) => w.open >= w.close)) ctx.addIssue({ code: 'custom', path: ['specialDays'], message: `on ${d.date}, a window must close after it opens` });
  }
  const specialDupe = (c.specialDays ?? []).map((d) => d.date).find((d, i, all) => all.indexOf(d) !== i);
  if (specialDupe) ctx.addIssue({ code: 'custom', path: ['specialDays'], message: `${specialDupe} is listed twice` });
  // ids are what bookings and the assistant refer to, so each one names exactly one thing
  const dupe = (ids: string[]) => ids.find((id, i) => ids.indexOf(id) !== i);
  const provider = dupe(c.providers.map((p) => p.id));
  if (provider) ctx.addIssue({ code: 'custom', path: ['providers'], message: `two providers have the id ${provider}` });
  const visit = dupe(c.visitTypes.map((v) => v.id));
  if (visit) ctx.addIssue({ code: 'custom', path: ['visitTypes'], message: `two visit types have the id ${visit}` });
  // a value on a record is kept under its field's id
  for (const key of ['customFields', 'providerFields', 'requestFields'] as const) {
    const field = dupe((c[key] ?? []).map((f) => f.id));
    if (field) ctx.addIssue({ code: 'custom', path: [key], message: `two fields have the id ${field}` });
  }
  const link = dupe((c.texting?.links ?? []).map((l) => l.id));
  if (link) ctx.addIssue({ code: 'custom', path: ['texting', 'links'], message: `two links have the id ${link}` });
  // each other language's greeting discloses the AI in that language, like the main one
  for (const [l, text] of Object.entries(c.greetings ?? {}) as [Language, string][]) {
    if (l === c.primaryLanguage || !c.languages.includes(l)) {
      ctx.addIssue({ code: 'custom', path: ['greetings', l], message: `a ${PACKS[l].name} greeting is only for a language the assistant also speaks, other than the main one` });
    } else if (!PACKS[l].disclosure.test(normalise(text))) {
      ctx.addIssue({ code: 'custom', path: ['greetings', l], message: `the ${PACKS[l].name} greeting must say that the caller is speaking with an AI assistant` });
    }
  }

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
  if (c.greetings && typeof c.greetings === 'object') c.greetings = knownNames(c.greetings);
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
export function clinicWarnings(c: Pick<ClinicConfig, 'greeting' | 'assistantName'> & Partial<Pick<ClinicConfig, 'routing' | 'phoneNumbers' | 'texting' | 'address' | 'industry' | 'emergencyHospital'>>): { path: 'greeting' | 'assistantName' | 'routing' | 'texting' | 'address' | 'emergency'; message: string }[] {
  const out: { path: 'greeting' | 'assistantName' | 'routing' | 'texting' | 'address' | 'emergency'; message: string }[] = [];
  if (c.industry === 'vet' && !c.emergencyHospital) out.push({ path: 'emergency', message: 'No emergency hospital yet. An owner whose animal is in danger hears only "go to the nearest 24-hour emergency vet". Add yours under Emergency hospitals.' });
  if (!c.address?.trim()) out.push({ path: 'address', message: 'No address yet. Callers who ask where you are hear that the assistant does not have it. Add it below, under Address.' });
  if (c.texting?.enabled && c.texting.kinds.directions && !c.address?.trim()) out.push({ path: 'texting', message: 'Directions texts are on, but the clinic has no address. Add it under General.' });
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
/**
 * The number a text tells people to call: the clinic's own line, the one its clients know, when it
 * has one (Settings keeps the assistant's numbers first and the clinic's own lines after them);
 * otherwise the assistant's. Texts themselves go out from the assistant's number.
 */
export const callUsNumber = (clinic: Pick<ClinicConfig, 'phoneNumbers'>): string => clinic.phoneNumbers[1] ?? clinic.phoneNumbers[0]!;

export const localName = (thing: { name: string; names?: Partial<Record<Language, string>> }, language: Language) =>
  thing.names?.[language] ?? thing.name;

/** The greeting for a language: the main greeting, the clinic's own for another language, or that language's suggestion. */
export function greetingFor(c: Pick<ClinicConfig, 'greeting' | 'greetings' | 'primaryLanguage' | 'assistantName' | 'name'>, language: Language): string {
  if (language === c.primaryLanguage) return c.greeting;
  return c.greetings?.[language] ?? PACKS[language].greeting({ assistantName: c.assistantName ?? null, clinicName: c.name });
}

/** The clinic's texting settings, with every default filled in. */
export const textingOf = (c: Pick<ClinicConfig, 'texting'>): Texting => c.texting ?? Texting.parse({});
/** The clinic's booking rules, with the defaults for what it has not set. */
export const bookingOf = (c: Pick<ClinicConfig, 'booking'>): BookingRules => BookingRules.parse(c.booking ?? {});

/**
 * A list as the clinic keeps it, or, before it has kept one, what its records say:
 * every specialty and category its doctors have, in alphabetical order.
 */
export function managedList(c: Pick<ClinicConfig, 'lists' | 'providers'>, name: ListName): string[] {
  const kept = c.lists?.[name];
  if (kept) return kept;
  if (name === 'species') return [...DEFAULT_SPECIES];
  const found = name === 'specialties' ? c.providers.map((p) => p.specialty ?? '') : c.providers.flatMap((p) => p.categories);
  const byKey = new Map<string, string>();
  for (const v of found.map((x) => x.trim()).filter(Boolean)) if (!byKey.has(v.toLowerCase())) byKey.set(v.toLowerCase(), v);
  return [...byKey.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * A list saved with renames and removals: the new list, and every doctor's specialty
 * and categories brought in line with it. A renamed value is renamed on every doctor;
 * a removed one is taken off them. Species are only a list (each pet keeps its own).
 */
export function applyListChange(c: ClinicConfig, name: ListName, values: string[], renamed: Record<string, string>): ClinicConfig {
  const next = { ...c, lists: { ...c.lists, [name]: values } };
  if (name === 'species') return next;
  const before = managedList(c, name);
  const keep = new Map(values.map((v) => [v.toLowerCase(), v]));
  const map = (v: string): string | null => {
    const to = renamed[v] ?? Object.entries(renamed).find(([from]) => from.toLowerCase() === v.toLowerCase())?.[1];
    if (to !== undefined) return keep.get(to.toLowerCase()) ?? null;
    if (keep.has(v.toLowerCase())) return keep.get(v.toLowerCase())!;
    // a value no list had is the doctor's own and stays; one the list had and lost is removed
    return before.some((b) => b.toLowerCase() === v.toLowerCase()) ? null : v;
  };
  next.providers = c.providers.map((p) => name === 'specialties'
    ? { ...p, specialty: p.specialty ? map(p.specialty) ?? undefined : undefined }
    : { ...p, categories: [...new Set(p.categories.map(map).filter((x): x is string => !!x))] });
  return next;
}

/** How many doctors use each value of a list: before a value is removed, the clinic sees what it touches. */
export function listUsage(c: Pick<ClinicConfig, 'providers'>, name: ListName): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of c.providers) {
    const vals = name === 'specialties' ? (p.specialty ? [p.specialty] : []) : name === 'categories' ? p.categories : [];
    for (const v of vals) out[v.toLowerCase()] = (out[v.toLowerCase()] ?? 0) + 1;
  }
  return out;
}
