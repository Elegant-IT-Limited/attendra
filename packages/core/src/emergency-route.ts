// SPDX-License-Identifier: AGPL-3.0-only
import { type ClinicConfig, type EmergencyHospital, emergencyHospitalsOf, type EmergencyMode, type EmergencySettings } from './clinic';
import { firstOpenHospital, specialDayOf, windowsOn } from './hours';
import { type Language, PACKS } from './locales';
import { localParts, toMinutes, weekdayOf } from './time';

/**
 * Where an animal's emergency goes, the one source of truth for it (batch 1b, FRIDAY notes): the assistant, the
 * Settings preview ("What callers will hear"), the setup page and the test-call page all read it from here.
 *
 * | Mode    | Emergency hours open            | Closed                      |
 * |---------|---------------------------------|-----------------------------|
 * | refer   | the hospital: said, and texted  | the same                    |
 * | handle  | a live transfer to the team     | the same (on call)          |
 * | hours   | a live transfer to the team     | the after-hours hospital    |
 *
 * A person in danger always hears the public emergency number (911), whatever the mode; that is not a route.
 */
export interface EmergencyRoute {
  /** The clinic's mode; null when it has none yet (no hospital set: callers hear "the nearest 24-hour emergency vet"). */
  mode: EmergencyMode | null;
  /** Whether the team's emergency hours are open now (always for handle; never for refer). */
  open: boolean;
  action: 'refer' | 'transfer' | 'none';
  /** The hospital said and texted (refer, and hours when closed): the first of the clinic's choices open now. */
  hospital: EmergencyHospital | null;
  /** The team's emergency line, for a transfer and for "call us if it comes back". */
  number: string | null;
  /** After a transfer nobody took: the hospital to give a caller who can't wait (handle's backup, or hours' after-hours one). */
  backup: EmergencyHospital | null;
  /** When the team's emergency hours end today ("18:00"), while they are open (hours mode). */
  closesAt: string | null;
}

/**
 * The clinic's emergency setting: the ONLY source of a vet clinic's route (batch 1e). A clinic without one has no route
 * yet (callers hear "the nearest 24-hour emergency vet"); one saved before batch 1b is folded into it by
 * `pnpm db:emergency-settings`, never read from its older fields here.
 */
export function emergencySettingsOf(clinic: Pick<ClinicConfig, 'emergencies'>): EmergencySettings | null {
  return clinic.emergencies ?? null;
}

type RouteClinic = Pick<ClinicConfig, 'emergencies' | 'hours' | 'holidays' | 'specialDays' | 'timezone'>;

/**
 * The hospital to name now outside the route's own steps (the guardrail's immediate script, a paused assistant, the
 * backup line): the first of the setting's hospitals open at this moment, or null.
 */
export function hospitalNow(clinic: Pick<ClinicConfig, 'emergencies' | 'timezone'>, at: Date): EmergencyHospital | null {
  return firstOpenHospital(emergencyHospitalsOf(clinic.emergencies), clinic.timezone, at);
}

/**
 * Whether the team takes emergencies now, in `hours` mode: its emergency hours (the opening hours unless set), with
 * holidays and special days closed. Returns the window's end too.
 */
export function emergencyHoursOpen(clinic: Pick<ClinicConfig, 'hours' | 'holidays' | 'specialDays' | 'timezone'>, hours: ClinicConfig['hours'] | undefined, at: Date): { open: boolean; closesAt: string | null } {
  const local = localParts(at, clinic.timezone);
  if (clinic.holidays.includes(local.date) || specialDayOf(clinic, local.date)) return { open: false, closesAt: null };
  const now = windowsOn(hours ?? clinic.hours, weekdayOf(local.date)).find((w) => local.minutes >= toMinutes(w.open) && local.minutes < toMinutes(w.close));
  return { open: !!now, closesAt: now?.close ?? null };
}

/** The route for a clinic with its emergency hours open or closed, as the Settings preview shows both. */
export function routeWhen(clinic: RouteClinic, open: boolean, at: Date, closesAt: string | null = null): EmergencyRoute {
  const e = emergencySettingsOf(clinic);
  // the first of the clinic's hospitals open at this moment (each may have its own hours); none open, the first anyway
  const first = (h: EmergencyHospital) => firstOpenHospital([h, ...(e?.moreHospitals ?? [])], clinic.timezone, at) ?? h;
  if (!e) return { mode: null, open: false, action: 'none', hospital: null, number: null, backup: null, closesAt: null };
  if (e.mode === 'refer') return { mode: 'refer', open: false, action: 'refer', hospital: first(e.hospital), number: null, backup: null, closesAt: null };
  if (e.mode === 'handle') return { mode: 'handle', open: true, action: 'transfer', hospital: null, number: e.number, backup: e.backupHospital ? first(e.backupHospital) : null, closesAt: null };
  return open
    ? { mode: 'hours', open: true, action: 'transfer', hospital: null, number: e.number, backup: first(e.afterHoursHospital), closesAt }
    : { mode: 'hours', open: false, action: 'refer', hospital: first(e.afterHoursHospital), number: e.number, backup: null, closesAt: null };
}

/** Where an animal's emergency goes right now. */
export function emergencyRoute(clinic: RouteClinic, now: Date): EmergencyRoute {
  const e = emergencySettingsOf(clinic);
  const hours = e?.mode === 'hours' ? emergencyHoursOpen(clinic, e.hours, now) : { open: false, closesAt: null };
  return routeWhen(clinic, hours.open, now, hours.closesAt);
}

/** Words for a pet the call has not named. */
const yourPet = (language: Language, pet: string | null) => pet ?? (language === 'es' ? 'su mascota' : 'your pet');

/** "6 PM" in North America, "18:00" elsewhere. */
function clock(hhmm: string, twelveHour: boolean) {
  if (!twelveHour) return hhmm;
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * What the caller hears, word for word, at each step of an animal's emergency, in each language. The assistant says
 * these (the state machine hands them over); the Settings preview shows the same.
 */
export const EMERGENCY_LINES = {
  /** After a red flag: one caring line and the one question. */
  question: (language: Language) => (language === 'es'
    ? 'Lo siento mucho. ¿Sigue siendo una emergencia ahora mismo? ¿Necesita ayuda para recibir atención de emergencia?'
    : 'I\'m sorry to hear that. Is this still an emergency right now? Do you need help getting emergency care?'),
  /** A sign that may be mild (bleeding, vomiting, limping, not eating): one question on how bad it is. */
  borderlineQuestion: (language: Language) => (language === 'es' ? 'Lamento oír eso. ¿Es grave o no para ahora mismo?' : 'I\'m sorry to hear that. Is it severe or nonstop right now?'),
  /** After a bare "it's not an emergency": one question about the sign itself. */
  signQuestion: (language: Language, pet: string | null) => (language === 'es'
    ? `De acuerdo. Para estar seguros: ¿${yourPet(language, pet)} sigue con ese problema ahora mismo?`
    : `Okay. Just to be safe: is ${yourPet(language, pet)} still having that problem right now?`),
  /** A yes (or "not sure"), routed to a hospital. */
  refer: (language: Language, pet: string | null, h: EmergencyHospital | null) => {
    const who = yourPet(language, pet);
    if (language === 'es') return h ? `Por favor lleve a ${who} ahora mismo a ${h.name}, en ${h.address}. Su número es ${PACKS.es.speakPhone(h.phone)}.` : `Por favor lleve a ${who} ahora mismo al hospital veterinario de emergencias de 24 horas más cercano.`;
    return h ? `Please take ${who} to ${h.name} at ${h.address} right away. Their number is ${PACKS.en.speakPhone(h.phone)}.` : `Please take ${who} to the nearest 24-hour emergency vet right away.`;
  },
  /** A yes (or "not sure"), routed to the team. */
  transfer: (language: Language) => (language === 'es' ? 'Le comunico con nuestro equipo ahora mismo. Por favor no cuelgue.' : 'I\'m putting you through to our team now. Please stay on the line.'),
  /** The transfer did not go through: an urgent request instead, and the team's emergency line. */
  transferFailed: (language: Language, number: string | null) => {
    const line = number ? (language === 'es' ? ` También puede llamar a nuestra línea de emergencias al ${PACKS.es.speakPhone(number)}.` : ` You can also call our emergency line at ${PACKS.en.speakPhone(number)}.`) : '';
    return language === 'es'
      ? `No pude comunicarme con el equipo en este momento, así que lo marqué como urgente: nuestro equipo le llamará de inmediato.${line}`
      : `I couldn't reach the team just now, so I've marked this as urgent: our team will call you right away.${line}`;
  },
  /** After a failed transfer, to a caller who says they can't wait: the backup hospital. */
  cantWait: (language: Language, h: EmergencyHospital) => (language === 'es'
    ? `Si no puede esperar, vaya a ${h.name}, en ${h.address}. Su número es ${PACKS.es.speakPhone(h.phone)}.`
    : `If you can't wait, go to ${h.name} at ${h.address}. Their number is ${PACKS.en.speakPhone(h.phone)}.`),
  /** A clear no: what to do if the sign comes back, said once. */
  ifReturns: (language: Language, pet: string | null, route: EmergencyRoute) => {
    const who = yourPet(language, pet);
    if (route.action === 'transfer' && route.number) {
      return language === 'es' ? `Si vuelve a pasar, llámenos al ${PACKS.es.speakPhone(route.number)}, o venga directamente.` : `If it comes back, call us at ${PACKS.en.speakPhone(route.number)}, or come straight in.`;
    }
    const h = route.hospital;
    if (language === 'es') return h ? `Si vuelve a pasar, lleve a ${who} a ${h.name} de inmediato.` : `Si vuelve a pasar, lleve a ${who} al hospital veterinario de emergencias de 24 horas más cercano de inmediato.`;
    return h ? `If it comes back, take ${who} to ${h.name} right away.` : `If it comes back, take ${who} to the nearest 24-hour emergency vet right away.`;
  },
} as const;

/** Where the "no emergency setting yet" line points: Settings and the test-call page send to Settings > Emergencies; the setup page has the choices right under it. */
export const NO_SETTING_NEXT = { settings: 'Set one under Settings > Emergencies.', setup: 'Choose one below.' } as const;
export type CallLinePlace = keyof typeof NO_SETTING_NEXT;

/**
 * The one line on the test-call page, Settings > Emergencies and the setup page: where an emergency call goes now, in the
 * dashboard's words (staff only, so English only). "Emergency calls here: transfer to the team now (open until 6 PM),
 * Riverside Emergency Vet after." `place` changes only where a clinic with no setting is pointed to.
 */
export function emergencyCallLine(clinic: RouteClinic & Pick<ClinicConfig, 'phoneNumbers'>, now: Date, place: CallLinePlace = 'settings'): string {
  const r = emergencyRoute(clinic, now);
  const twelve = (clinic.phoneNumbers[0] ?? '').startsWith('+1');
  const after = r.backup?.name ?? 'the hospital';
  if (r.mode === null) return `Emergency calls here: no emergency setting yet, so callers hear "the nearest 24-hour emergency vet". ${NO_SETTING_NEXT[place]}`;
  if (r.mode === 'refer') return `Emergency calls here: sent to ${r.hospital?.name ?? 'the nearest 24-hour emergency vet'}, any time.`;
  if (r.mode === 'handle') return 'Emergency calls here: transfer to the team now, any time.';
  if (r.open) return `Emergency calls here: transfer to the team now (open until ${clock(r.closesAt ?? '00:00', twelve)}), ${after} after.`;
  return `Emergency calls here: sent to ${r.hospital?.name ?? 'the hospital'} now (outside the team's emergency hours); transfer to the team in its hours.`;
}

/** What callers will hear, for the Settings preview: each step, in one language, with the emergency hours open or closed. */
export function emergencyPreview(clinic: RouteClinic, language: Language, open: boolean, at: Date) {
  const route = routeWhen(clinic, open, at);
  // a made-up pet's name, so the lines read as a caller hears them
  const pet = 'Luna';
  return {
    route,
    question: EMERGENCY_LINES.question(language),
    yes: route.action === 'transfer' ? EMERGENCY_LINES.transfer(language) : EMERGENCY_LINES.refer(language, pet, route.hospital),
    transferFailed: route.action === 'transfer' ? EMERGENCY_LINES.transferFailed(language, route.number) : null,
    clearNo: EMERGENCY_LINES.ifReturns(language, pet, route),
  };
}
