// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PHI never reaches a log line, a trace attribute or an error report. Two layers:
 * fields with a PHI name are replaced outright, and every remaining string is
 * scrubbed for things that look like phone numbers, dates of birth and email
 * addresses. The second layer exists because PHI turns up in free text ("caller
 * said her DOB is 3/4/1985") where no field name can warn us.
 */

export const PHI_KEYS = new Set([
  'name', 'full_name', 'fullname', 'first_name', 'last_name', 'patient_name', 'caller_name',
  'dob', 'date_of_birth', 'birth_date', 'birthdate',
  'phone', 'phone_number', 'callback_number', 'from', 'to', 'caller_id', 'ani',
  'email', 'address', 'ssn', 'mrn', 'insurance_id', 'member_id',
  'transcript', 'text', 'delta', 'content', 'utterance', 'message_body', 'body',
  'medication', 'pharmacy', 'reason', 'symptoms', 'notes', 'note',
]);

const PATTERNS: [RegExp, string][] = [
  [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[email]'],
  [/(\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '[phone]'],
  [/\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g, '[date]'],
  [/\b\d{4}-\d{2}-\d{2}\b/g, '[date]'],
  [/\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)\.? \d{1,2}(st|nd|rd|th)?,? \d{4}\b/gi, '[date]'],
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[ssn]'],
];

export function scrubText(s: string): string {
  return PATTERNS.reduce((acc, [re, label]) => acc.replace(re, label), s);
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
