// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PHI never reaches a log line, a trace attribute or an error report. Two layers:
 * fields with a PHI name are replaced outright, and every remaining string is
 * scrubbed for things that look like phone numbers (North American, with a country
 * code, or national with a leading 0), dates of birth (in English, either order, and
 * in Spanish) and email addresses. The second layer exists because PHI turns up in free text ("caller
 * said her DOB is 3/4/1985") where no field name can warn us.
 */

export const PHI_KEYS = new Set([
  'name', 'full_name', 'fullname', 'first_name', 'last_name', 'patient_name', 'caller_name',
  'dob', 'date_of_birth', 'birth_date', 'birthdate',
  'phone', 'phone_number', 'callback_number', 'from', 'to', 'caller_id', 'ani',
  'email', 'address', 'ssn', 'mrn', 'insurance_id', 'member_id',
  'transcript', 'text', 'delta', 'content', 'utterance', 'message_body', 'body',
  'medication', 'pharmacy', 'reason', 'symptoms', 'notes', 'note', 'query', 'search',
]);

const MONTHS_EN = '(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)';
const MONTHS_ES = '(enero|febrero|marzo|abril|mayo|junio|julio|agosto|sept?iembre|octubre|noviembre|diciembre)';

/** A number written with its country code (+44 20 7946 0958), or a national one that starts with 0 (020 7946 0958). */
const phoneLike = (m: string) => {
  const digits = m.replace(/\D/g, '').length;
  return digits >= 8 && digits <= 15 ? '[phone]' : m;
};

const PATTERNS: [RegExp, string | ((m: string) => string)][] = [
  [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[email]'],
  [/(\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '[phone]'],
  [/\+\d[\d\s().-]{6,20}\d/g, phoneLike],
  // not inside an id: a UUID (01234567-1234-...) or call_0123456789 is not a number to hide
  [/(?<![\w-])0\d{2,4}[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?![\w-])/g, phoneLike],
  [/\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g, '[date]'],
  [/\b\d{4}-\d{2}-\d{2}\b/g, '[date]'],
  [new RegExp(`\\b${MONTHS_EN}\\.? \\d{1,2}(st|nd|rd|th)?,? \\d{4}\\b`, 'gi'), '[date]'],
  // day first, as outside the United States: 4 March 1985, 4th of March 1985
  [new RegExp(`\\b\\d{1,2}(st|nd|rd|th)?( of)? ${MONTHS_EN}\\.?,? \\d{4}\\b`, 'gi'), '[date]'],
  // Spanish: 4 de marzo de 1985, and 4 de marzo on its own
  [new RegExp(`\\b\\d{1,2} de ${MONTHS_ES}( de(l)? \\d{4})?`, 'gi'), '[date]'],
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[ssn]'],
];

export function scrubText(s: string): string {
  return PATTERNS.reduce((acc, [re, label]) => (typeof label === 'string' ? acc.replace(re, label) : acc.replace(re, label)), s);
}

export function redact<T>(value: T, depth = 0): T {
  if (depth > 8) return '[depth]' as T;
  if (typeof value === 'string') return scrubText(value) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  if (value && typeof value === 'object') {
    if (value instanceof Date) return value;
    if (value instanceof Error) return { type: value.name, message: scrubText(value.message) } as T;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = PHI_KEYS.has(k.toLowerCase()) ? '[redacted]' : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}
