// SPDX-License-Identifier: AGPL-3.0-only
import { normalise } from './locales/types';
import { addDays, localParts } from './time';

/**
 * Whether the assistant's words carry a booking's day and time: only then has it been read back (batch 1c). A live
 * run booked on a "Sí" that came after "I found Biscuit", because any speech after the proposal counted. The day is
 * its weekday ("Friday", "el viernes"), or "today"/"tomorrow" when it is; the time is its clock time, in digits
 * ("5:30", "9 AM", "9:00") or words ("five thirty", "nine o'clock", "las cinco y media", "las nueve"). English and
 * Spanish, accents folded.
 */
const DAYS: Record<number, string[]> = {
  0: ['sunday', 'domingo'], 1: ['monday', 'lunes'], 2: ['tuesday', 'martes'], 3: ['wednesday', 'miercoles'],
  4: ['thursday', 'jueves'], 5: ['friday', 'viernes'], 6: ['saturday', 'sabado'],
};
const HOURS_EN = ['twelve', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven'];
const HOURS_ES = ['doce', 'una', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once'];
const MINUTES: Record<number, string[]> = {
  5: ['oh five', 'o five', 'y cinco'], 10: ['ten', 'y diez'], 15: ['fifteen', 'quarter', 'y cuarto', 'y quince'],
  20: ['twenty', 'y veinte'], 25: ['twenty five', 'twenty-five', 'y veinticinco'], 30: ['thirty', 'half past', 'y media', 'y treinta'],
  35: ['thirty five', 'thirty-five', 'y treinta y cinco'], 40: ['forty', 'y cuarenta'], 45: ['forty five', 'forty-five', 'y cuarenta y cinco'],
  50: ['fifty', 'y cincuenta'], 55: ['fifty five', 'fifty-five', 'y cincuenta y cinco'],
};

const has = (text: string, word: string) => new RegExp(`(?:^|[^a-z0-9])${word.replace(/[-]/g, '[- ]')}(?:$|[^a-z0-9])`).test(text);

/** The day as said: its weekday, or "today"/"tomorrow" (EN/ES) when the slot is on one. */
function saysDay(t: string, start: Date, timeZone: string, now: Date): boolean {
  const slot = localParts(start, timeZone);
  if (DAYS[slot.weekday]!.some((d) => has(t, d))) return true;
  const today = localParts(now, timeZone).date;
  if (slot.date === today && (has(t, 'today') || has(t, 'hoy') || has(t, 'this (?:morning|afternoon|evening)') || has(t, 'esta (?:manana|tarde|noche)'))) return true;
  // "mañana" alone is tomorrow; "de la mañana" is the morning
  return slot.date === addDays(today, 1) && (has(t, 'tomorrow') || /(?:^|[^a-z])(?<!de la )manana(?:$|[^a-z])/.test(t));
}

/** The clock time as said, in digits or words. */
function saysTime(t: string, start: Date, timeZone: string): boolean {
  const { minutes } = localParts(start, timeZone);
  const h24 = Math.floor(minutes / 60);
  const m = minutes % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const mm = String(m).padStart(2, '0');
  // digits: "5:30", "5.30", "17:30"; on the hour also "9 am", "9 p.m.", "a las 9"
  for (const h of new Set([h12, h24])) {
    if (new RegExp(`(?:^|[^0-9])${h}[:.]${mm}(?:$|[^0-9])`).test(t)) return true;
    if (m === 0 && new RegExp(`(?:^|[^0-9:.])${h}\\s*(?:am|pm|a\\.?\\s?m|p\\.?\\s?m|o'?clock|de la|en punto)`).test(t)) return true;
    if (m === 0 && new RegExp(`a las ${h}(?:$|[^0-9:.])`).test(t)) return true;
  }
  // words: "five thirty", "half past five", "las cinco y media", "nine o'clock", "las nueve"
  const en = HOURS_EN[h12 % 12]!;
  const es = HOURS_ES[h12 % 12]!;
  if (m === 0) return has(t, `${en} (?:am|pm|a m|p m|o'?clock|in the)`) || has(t, `las ${es}`) || has(t, `la ${es}`);
  return (MINUTES[m] ?? []).some((w) => has(t, `${en} ${w}`) || has(t, `${w} ${en}`) || has(t, `${es} ${w}`) || (w === 'half past' && has(t, `half past ${en}`)) || (w === 'quarter' && has(t, `quarter past ${en}`)));
}

export function saysSlot(spoken: string, start: Date, timeZone: string, now: Date): boolean {
  const t = normalise(spoken).replace(/\s+/g, ' ');
  return saysDay(t, start, timeZone, now) && saysTime(t, start, timeZone);
}
