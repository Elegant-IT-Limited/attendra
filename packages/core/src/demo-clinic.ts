// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { Language } from './locales';
import { addDays, localParts, zonedInstant } from './time';

/**
 * A demo clinic: a hosted location whose number prospects ring to try the assistant (2026-11-16). Strangers, and maybe
 * bots, call it, so it has limits that stop abuse before it costs money, emergency wording that sends nobody to a real
 * hospital, and a nightly reset to the data it was set up with. Off by default; set only by the operator (provisioning,
 * from the back office, on a clinic marked as an internal test clinic), never in Settings. Every rule here reads
 * `isDemoClinic`: a clinic without the flag behaves exactly as before.
 */
export const DemoClinic = z.object({
  enabled: z.boolean(),
  /** When the data the nightly reset restores was taken ("Set demo baseline now"); null until it is. */
  baselineAt: z.iso.datetime().nullable().default(null),
});
export type DemoClinic = z.infer<typeof DemoClinic>;

export const isDemoClinic = (c: { demoClinic?: DemoClinic | undefined }): boolean => c.demoClinic?.enabled === true;

/** The demo line's limits. The plan's monthly minutes (the tester cap) still apply on top, as for any clinic. */
export const DEMO_LIMITS = {
  /** One call: the assistant wraps up at 14:00 and the line closes at 15:00. */
  callSeconds: 15 * 60,
  wrapUpAtSeconds: 14 * 60,
  /** Phone calls one caller number may make in a clinic day (counted by the number's keyed hash). */
  callsPerCallerPerDay: 5,
  /** Phone minutes the whole clinic may take in a clinic day. */
  clinicSecondsPerDay: 60 * 60,
} as const;

/** Why a call to a demo clinic is turned away: the code its record keeps. */
export const DEMO_LIMIT_CODES = ['demo_caller_calls', 'demo_clinic_minutes'] as const;
export type DemoLimitCode = (typeof DEMO_LIMIT_CODES)[number];

/** Today's use of the demo line, in the clinic's day: this caller's answered calls, and every phone call's seconds. */
export interface DemoUsage { callerCalls: number; clinicSeconds: number }

/**
 * Whether a new phone call to a demo clinic is turned away, and why; null lets it through. Checked when the call
 * arrives, before any model runs. A caller with no number (withheld) is held to the clinic's minutes only.
 */
export function demoLimitHit(usage: DemoUsage): DemoLimitCode | null {
  if (usage.clinicSeconds >= DEMO_LIMITS.clinicSecondsPerDay) return 'demo_clinic_minutes';
  if (usage.callerCalls >= DEMO_LIMITS.callsPerCallerPerDay) return 'demo_caller_calls';
  return null;
}

/** The one fixed line a turned-away caller hears, in the clinic's main language; then the call ends. */
export const DEMO_BUSY_LINE: Record<Language, string> = {
  en: 'Thanks for calling the Attendra demo line. It\'s busy for you right now, please try again tomorrow.',
  es: 'Gracias por llamar a la línea de demostración de Attendra. Ahora mismo está ocupada para usted, por favor vuelva a intentarlo mañana.',
};

/** What a demo clinic's emergency route says instead of a hospital or a transfer: nothing is texted, nobody is put through. */
export const DEMO_EMERGENCY_LINE: Record<Language, string> = {
  en: 'This is a demo line, so I can\'t send you to a real hospital. If your pet needs help right now, please call your own vet or the nearest emergency hospital.',
  es: 'Esta es una línea de demostración, así que no puedo enviarle a un hospital real. Si su mascota necesita ayuda ahora mismo, llame a su propio veterinario o al hospital de emergencias más cercano.',
};

/** After the demo line, a caller who says it is not an emergency now hears what to do if it comes back, with no hospital named. */
export const DEMO_EMERGENCY_IF_RETURNS: Record<Language, string> = {
  en: 'If it comes back, please call your own vet or the nearest emergency hospital right away.',
  es: 'Si vuelve a pasar, llame de inmediato a su propio veterinario o al hospital de emergencias más cercano.',
};

/** At 14:00 of a demo call: one polite line, then the call ends at 15:00. */
export const DEMO_WRAP_UP = 'This demo call has about a minute left. Finish what you are doing quickly. The next time you speak, tell the caller in one short, polite sentence that the demo call ends in about a minute and that they are welcome to call again.';
export const DEMO_TIME_UP = 'The demo call has reached its time limit. Stop the current task. Thank the caller in one short sentence for trying the demo, then say nothing more.';

/**
 * The same two moments as fixed lines, for an engine that says words as given (Vapi's call control): the voice model of
 * our own engines gets the instructions above and says it in its own words.
 */
export const DEMO_WRAP_UP_LINE: Record<Language, string> = {
  en: 'Just so you know, this demo call ends in about a minute. You\'re welcome to call again any time.',
  es: 'Le aviso que esta llamada de demostración termina en un minuto aproximadamente. Puede volver a llamar cuando quiera.',
};
export const DEMO_GOODBYE_LINE: Record<Language, string> = {
  en: 'This demo call has reached its time limit. Thanks for trying Attendra, goodbye.',
  es: 'Esta llamada de demostración ha llegado a su límite de tiempo. Gracias por probar Attendra, adiós.',
};

/** The clinic's day a moment falls in, as [start, end) instants: the demo limits count calls inside it. */
export function clinicDay(timeZone: string, at: Date): { date: string; start: Date; end: Date } {
  const { date } = localParts(at, timeZone);
  return { date, start: zonedInstant(date, '00:00', timeZone), end: zonedInstant(addDays(date, 1), '00:00', timeZone) };
}

/** The nightly reset's time, on the clinic's clock. */
export const DEMO_RESET_AT = '03:30';

/**
 * The latest scheduled reset at or before `at` (03:30 today, or yesterday's before 03:30), in the clinic's zone: a demo
 * clinic whose last reset is older than this is due one. Run every few minutes, so a worker that was down catches up once.
 */
export function demoResetDue(timeZone: string, at: Date): Date {
  const today = localParts(at, timeZone).date;
  const slot = zonedInstant(today, DEMO_RESET_AT, timeZone);
  return slot.getTime() <= at.getTime() ? slot : zonedInstant(addDays(today, -1), DEMO_RESET_AT, timeZone);
}
