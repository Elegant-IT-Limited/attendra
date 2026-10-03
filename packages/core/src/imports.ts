// SPDX-License-Identifier: AGPL-3.0-only
import { type ClinicConfig, Provider } from './clinic';
import { parseDob } from './identity';
import { ageOn } from './providers';

/**
 * Bulk lists the managers keep in a spreadsheet: doctors and patients, as CSV (Excel,
 * Numbers and Google Sheets all save it). One template per list, with the columns in
 * this order; a file may leave out optional columns or add others, which are ignored.
 */

/** RFC 4180: commas, quotes doubled inside quoted fields, CRLF or LF, a byte order mark from Excel. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
export const toCsv = (rows: string[][]) => `${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;

/** A file's rows as objects keyed by lower-case header, each with its line number in the file. */
function records(text: string): { line: number; get: (col: string) => string; headers: string[] }[] {
  const [head, ...body] = parseCsv(text);
  if (!head) return [];
  const headers = head.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return body.map((r, i) => ({ line: i + 2, headers, get: (col: string) => (r[headers.indexOf(col)] ?? '').trim() }));
}

export const MAX_IMPORT_ROWS = 5000;

const DAY_COLUMNS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const DAY_INDEX: Record<(typeof DAY_COLUMNS)[number], string> = { mon: '1', tue: '2', wed: '3', thu: '4', fri: '5', sat: '6', sun: '0' };

export const DOCTOR_COLUMNS = ['id', 'name', 'specialty', 'categories', 'ages_min', 'ages_max', 'accepting_new_patients', 'visit_types', ...DAY_COLUMNS, 'time_off'] as const;
export const PATIENT_COLUMNS = ['first_name', 'last_name', 'date_of_birth', 'phone', 'guardian_name'] as const;

/** The guide a template carries, in the order a manager fills it in. Shown next to the download, never written into the file. */
export const DOCTOR_GUIDE = [
  'One row per doctor. name is required; every other column may be left empty.',
  'id: leave empty to add a doctor. To change one already on file, keep the id the Doctors page shows, or the same name.',
  'categories and visit_types: several values separated by semicolons, like Children; Vaccinations. Visit types are the names in Settings.',
  'ages_min and ages_max: whole years. Leave ages_max empty for no upper limit; leave both empty for every age.',
  'accepting_new_patients: yes or no. Empty means yes.',
  'mon to sun: working hours like 08:00-12:00; 13:00-17:00. Leave a day empty when they do not work it. Leave all seven empty to use the clinic hours.',
  'time_off: days away like 2026-12-24 to 2026-12-31; 2027-01-15. Both ends are included.',
];
export const PATIENT_GUIDE = [
  'One row per patient. first_name, last_name, date_of_birth and phone are required.',
  'date_of_birth: YYYY-MM-DD, like 1985-03-04, or month/day/year, like 03/04/1985.',
  'phone: with the area code. A family may share one number: a parent and each child get a row of their own with the same phone.',
  'guardian_name: required for anyone under 18, the parent or guardian who books for them.',
  'A patient already on file with the same name, date of birth and phone is skipped, so the same file can be uploaded twice safely.',
];

export function doctorTemplate(clinic: Pick<ClinicConfig, 'visitTypes'>): string {
  const visits = clinic.visitTypes.map((v) => v.name);
  return toCsv([
    [...DOCTOR_COLUMNS],
    ['', 'Dr. Jane Example', 'Family medicine', 'Adults; Chronic conditions', '18', '', 'yes', visits.slice(0, 2).join('; '), '08:00-12:00; 13:00-17:00', '08:00-12:00; 13:00-17:00', '', '08:00-12:00; 13:00-17:00', '08:00-13:00', '', '', '2026-12-24 to 2026-12-31'],
    ['', 'Dr. Sam Example', 'Pediatrics', 'Children; Newborns; Vaccinations', '0', '17', 'yes', visits.join('; '), '', '', '', '', '', '', '', ''],
  ]);
}

export function patientTemplate(): string {
  return toCsv([
    [...PATIENT_COLUMNS],
    ['Jane', 'Example', '1985-03-04', '+1 303 555 0100', ''],
    ['Sam', 'Example', '2019-05-12', '+1 303 555 0100', 'Jane Example'],
  ]);
}

export type RowResult<T> = { line: number; name: string; ok: true; value: T; existingId?: string } | { line: number; name: string; ok: false; message: string };

const split = (v: string) => v.split(';').map((x) => x.trim()).filter(Boolean);
const yes = (v: string) => (v === '' ? true : /^(y|yes|true|1)$/i.test(v) ? true : /^(n|no|false|0)$/i.test(v) ? false : null);
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'doctor';
/** A new provider id, readable and unlikely to repeat: prov_jane_example_k3f9. */
export const newProviderId = (name: string) => `prov_${slug(name.replace(/^dr\.?\s+/i, ''))}_${Math.random().toString(36).slice(2, 6)}`;
const sameName = (a: string, b: string) => a.toLowerCase().replace(/[^a-z0-9]/g, '') === b.toLowerCase().replace(/[^a-z0-9]/g, '');

function hoursOf(v: string): { open: string; close: string }[] | string {
  const out: { open: string; close: string }[] = [];
  for (const part of split(v)) {
    const m = part.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    if (!m) return `"${part}" is not a time range like 08:00-12:00`;
    const open = `${m[1]!.padStart(2, '0')}:${m[2]}`;
    const close = `${m[3]!.padStart(2, '0')}:${m[4]}`;
    if (open >= close) return `${part} closes before it opens`;
    out.push({ open, close });
  }
  return out;
}

/**
 * Doctor rows checked against the clinic: each becomes a provider to add, or an update
 * to one already on file (by id, or else by the same name). Rows are checked with the
 * same schema as one doctor added on the page, so the import cannot save anything the
 * page would refuse.
 */
export function readDoctors(text: string, clinic: Pick<ClinicConfig, 'providers' | 'visitTypes'>): RowResult<Provider>[] {
  const rows = records(text);
  if (rows.length > MAX_IMPORT_ROWS) return [{ line: 1, name: '', ok: false, message: `at most ${MAX_IMPORT_ROWS} rows per file` }];
  if (rows.length && !rows[0]!.headers.includes('name')) return [{ line: 1, name: '', ok: false, message: 'the first row must be the column names, with a name column; download the template' }];
  const seen = new Set<string>();
  return rows.map((r): RowResult<Provider> => {
    const name = r.get('name');
    const fail = (message: string) => ({ line: r.line, name, ok: false as const, message });
    if (!name) return fail('name is required');
    const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seen.has(key)) return fail('this doctor is in the file twice');
    seen.add(key);
    const existing = (r.get('id') && clinic.providers.find((p) => p.id === r.get('id'))) || clinic.providers.find((p) => sameName(p.name, name));
    if (r.get('id') && !existing) return fail(`no doctor on file has the id ${r.get('id')}; leave id empty to add them`);
    const visitTypeIds: string[] = [];
    for (const v of split(r.get('visit_types'))) {
      const match = clinic.visitTypes.find((t) => t.id === v || sameName(t.name, v));
      if (!match) return fail(`"${v}" is not a visit type in Settings (${clinic.visitTypes.map((t) => t.name).join(', ')})`);
      visitTypeIds.push(match.id);
    }
    const accepting = yes(r.get('accepting_new_patients'));
    if (accepting === null) return fail('accepting_new_patients is yes or no');
    const min = r.get('ages_min');
    const max = r.get('ages_max');
    const hours: Record<string, { open: string; close: string }[]> = {};
    for (const d of DAY_COLUMNS) {
      const h = hoursOf(r.get(d));
      if (typeof h === 'string') return fail(`${d}: ${h}`);
      if (h.length) hours[DAY_INDEX[d]] = h;
    }
    const timeOff = [];
    for (const part of split(r.get('time_off'))) {
      const m = part.match(/^(\d{4}-\d{2}-\d{2})(?:\s+to\s+(\d{4}-\d{2}-\d{2}))?$/);
      if (!m) return fail(`time_off: "${part}" is not a date like 2026-12-24 or a range like 2026-12-24 to 2026-12-31`);
      timeOff.push({ from: m[1]!, to: m[2] ?? m[1]! });
    }
    const parsed = Provider.safeParse({
      ...existing,
      id: existing?.id ?? newProviderId(name),
      name,
      specialty: r.get('specialty') || undefined,
      categories: split(r.get('categories')),
      ages: min === '' && max === '' ? undefined : { min: min === '' ? 0 : Number(min), max: max === '' ? null : Number(max) },
      acceptingNewPatients: accepting,
      visitTypeIds: visitTypeIds.length ? visitTypeIds : existing?.visitTypeIds ?? clinic.visitTypes.map((v) => v.id),
      hours: Object.keys(hours).length ? hours : undefined,
      timeOff,
    });
    if (!parsed.success) return fail(parsed.error.issues.map((i) => `${i.path.join('.') || 'row'}: ${i.message}`).join('; '));
    return { line: r.line, name, ok: true, value: parsed.data, ...(existing ? { existingId: existing.id } : {}) };
  });
}

export interface PatientRow { firstName: string; lastName: string; dob: string; phone: string; guardianName: string | null }

/**
 * Patient rows checked on their own: required fields, a real date of birth, a phone
 * number with its area code, and a guardian for anyone under 18. The same person twice
 * in one file is caught here; the same person already on file is caught when it saves.
 */
export function readPatients(text: string, today: string, northAmerica = true): RowResult<PatientRow>[] {
  const rows = records(text);
  if (rows.length > MAX_IMPORT_ROWS) return [{ line: 1, name: '', ok: false, message: `at most ${MAX_IMPORT_ROWS} rows per file` }];
  if (rows.length && !['first_name', 'last_name', 'date_of_birth', 'phone'].every((c) => rows[0]!.headers.includes(c))) {
    return [{ line: 1, name: '', ok: false, message: 'the first row must be the column names: first_name, last_name, date_of_birth, phone, guardian_name; download the template' }];
  }
  const seen = new Set<string>();
  const todayDate = new Date(`${today}T12:00:00Z`);
  return rows.map((r): RowResult<PatientRow> => {
    const firstName = r.get('first_name');
    const lastName = r.get('last_name');
    const name = `${firstName} ${lastName}`.trim();
    const fail = (message: string) => ({ line: r.line, name, ok: false as const, message });
    if (!firstName || !lastName) return fail('first_name and last_name are required');
    const dob = parseDob(r.get('date_of_birth'), todayDate, northAmerica ? 'mdy' : 'dmy');
    if (!dob) return fail(`date_of_birth "${r.get('date_of_birth')}" is not a full date like 1985-03-04 or a date in the future`);
    const phone = r.get('phone');
    if (phone.replace(/\D/g, '').length < (northAmerica ? 10 : 7)) return fail('phone is required, with the area code');
    const guardianName = r.get('guardian_name') || null;
    if (ageOn(dob, today) < 18 && !guardianName) return fail('guardian_name is required for a patient under 18');
    const key = `${firstName.toLowerCase()}|${lastName.toLowerCase()}|${dob}|${phone.replace(/\D/g, '').slice(-10)}`;
    if (seen.has(key)) return fail('this patient is in the file twice');
    seen.add(key);
    return { line: r.line, name, ok: true, value: { firstName, lastName, dob, phone, guardianName } };
  });
}
