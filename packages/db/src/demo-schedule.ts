// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, ageOn, type ClinicConfig, DEMO_CLINIC, fromMinutes, localDateOf, type Provider, seesAge, toMinutes, weekdayOf, windowsOn, zonedInstant } from '@attendra/core';
import { and, eq, like } from 'drizzle-orm';
import { type Database, withClinic } from './client';
import { type PhiCipher, phiContext } from './crypto';
import { identityKey, PostgresPatientDirectory } from './repositories/patients';
import { appointments, patients } from './schema';

// the demo's invented first names that are women's; everyone else in the demo is a man
const FEMALE_NAMES = new Set(['Maria', 'Sofia', 'Ruth', 'Aisha', 'Grace', 'Hannah', 'Priscilla', 'Lucy', 'Elena', 'Nadia', 'Imani', 'Clara', 'June', 'Maya', 'Rosa',
  'Ava', 'Mia', 'Zoe', 'Chloe', 'Layla', 'Nora', 'Amara', 'Freya', 'Ingrid', 'Keiko', 'Margot', 'Olive', 'Ivy', 'Luna', 'Nina', 'Pia', 'Sana', 'Uma']);
/** A demo patient's gender, from their invented first name. */
export const demoGender = (firstName: string) => (FEMALE_NAMES.has(firstName) ? 'female' as const : 'male' as const);

/**
 * Invented first and last names crossed with each other, with numbers from a range
 * no one is given: enough patients that nobody needs more than two upcoming visits.
 */
function crossed(first: string[], last: string[], phone: (i: number) => string, seed: number) {
  const rand = random(seed);
  return first.flatMap((f) => last.map((l) => [f, l] as const)).map(([firstName, lastName], i) => {
    const year = 1940 + Math.floor(rand() * 68);
    const month = String(1 + Math.floor(rand() * 12)).padStart(2, '0');
    const dayOf = String(1 + Math.floor(rand() * 28)).padStart(2, '0');
    return { firstName, lastName, dob: `${year}-${month}-${dayOf}`, phone: phone(i) };
  });
}
const MAPLE_MORE = crossed(
  ['Ava', 'Noah', 'Mia', 'Ethan', 'Zoe', 'Lucas', 'Chloe', 'Samuel', 'Layla', 'Gabriel', 'Nora', 'Julian',
    'Amara', 'Diego', 'Freya', 'Hamza', 'Ingrid', 'Jonah', 'Keiko', 'Luis', 'Margot', 'Nikhil', 'Olive', 'Reuben'],
  ['Brennan', 'Castillo', 'Duarte', 'Ellison', 'Kowalski'],
  // 555-0100 to 555-0199 in two more Colorado area codes: the range kept for fiction
  (i) => `+1${i < 100 ? '719' : '970'}555${String(100 + (i % 100)).padStart(4, '0')}`, 7,
);

// Children for the pediatrician, each on a parent's number and with the parent named, as a family registers them
const MAPLE_KIDS = [
  ['Ivy', 'Brennan', '2015-04-09'], ['Kai', 'Castillo', '2018-09-23'], ['Luna', 'Duarte', '2021-01-30'], ['Milo', 'Ellison', '2012-06-14'],
  ['Nina', 'Kowalski', '2019-11-05'], ['Otis', 'Brennan', '2023-03-17'], ['Pia', 'Castillo', '2016-12-01'], ['Rafi', 'Duarte', '2014-08-27'],
  ['Sana', 'Ellison', '2020-05-19'], ['Tobi', 'Kowalski', '2011-10-08'], ['Uma', 'Brennan', '2024-07-02'], ['Vic', 'Castillo', '2013-02-25'],
].map(([firstName, lastName, dob], i) => ({ firstName: firstName!, lastName: lastName!, dob: dob!, phone: `+1970555${String(150 + i).padStart(4, '0')}`, guardianName: `Alex ${lastName}` }));

/**
 * More synthetic patients, so the demo schedule reads like a practice rather than
 * four people seen forty times. Invented names; every number is in the 555-01xx
 * range North America keeps for fiction.
 */
export const DEMO_SCHEDULE_PATIENTS = [
  ['Aisha', 'Bello', '1978-11-02'], ['Tomás', 'Herrera', '1994-05-21'], ['Grace', 'Lindahl', '1951-02-14'], ['Omar', 'Haddad', '1983-08-30'],
  ['Hannah', 'Brooks', '2001-12-09'], ['Wei', 'Chen', '1969-04-17'], ['Priscilla', 'Moreau', '1957-06-25'], ['Daniel', 'Okonkwo', '1988-01-11'],
  ['Lucy', 'Fairbanks', '1992-10-03'], ['Mateo', 'Vargas', '2010-03-28'], ['Ruth', 'Adeyemi', '1946-09-19'], ['Kenji', 'Mori', '1975-07-07'],
  ['Elena', 'Petrova', '1980-12-24'], ['Marcus', 'Greene', '1965-05-05'], ['Nadia', 'Rahman', '1999-02-27'], ['Owen', 'Gallagher', '1972-11-15'],
  ['Sofia', 'Lombardi', '1986-06-13'], ['Theo', 'Nakamura', '2004-08-08'], ['Imani', 'Carter', '1990-04-01'], ['Victor', 'Salazar', '1959-01-22'],
  ['Clara', 'Jensen', '1968-10-30'], ['Bilal', 'Qureshi', '1981-03-16'], ['June', 'Park', '1996-09-04'], ['Frank', 'Delaney', '1949-12-12'],
  ['Maya', 'Singh', '1987-07-29'], ['Isaac', 'Feldman', '1977-02-08'], ['Rosa', 'Ibáñez', '1963-05-18'], ['Leo', 'Marchetti', '2008-11-26'],
].map(([firstName, lastName, dob], i) => ({ firstName: firstName!, lastName: lastName!, dob: dob!, phone: `+1720555${String(110 + i).padStart(4, '0')}` }) as { firstName: string; lastName: string; dob: string; phone: string; guardianName?: string })
  .concat(MAPLE_MORE, MAPLE_KIDS);

/** A small, seeded generator: the same demo every time it starts, so screenshots and specs are stable. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The most upcoming visits any demo patient has. */
export const MAX_UPCOMING = 2;

const NOTES = ['Prefers a morning reminder call.', 'Bring the list of current medications.', 'Wheelchair access needed.', 'Interpreter: Spanish.', 'Follow-up from last visit.'];
const REASONS = ['patient_asked', 'patient_asked', 'clinic_asked', 'booked_in_error'] as const;

/**
 * Two weeks of a working calendar around `now`: from the Monday of this week to two
 * weeks out, about 60 percent of each provider's bookable time filled, a few
 * cancellations, and a note here and there. Staff made these bookings; the ones the
 * assistant made come from the demo calls themselves and are left where they are.
 * Nobody has more than two upcoming visits, those from the demo calls included, as
 * at a real practice: a later slot with no one left to see stays open.
 *
 * Runs once: a clinic whose calendar already holds seeded bookings is left alone.
 */
export async function seedDemoSchedule(db: Database, cipher: PhiCipher, opts: { patientIds: Record<string, string>; staffUserIds: string[]; now?: Date; clinic?: ClinicConfig; extraPatients?: typeof DEMO_SCHEDULE_PATIENTS; notes?: string[] }) {
  const clinic = opts.clinic ?? DEMO_CLINIC;
  const now = opts.now ?? new Date();
  if (!opts.staffUserIds.length) throw new Error('the demo schedule needs at least one staff member to have made its bookings');
  const [seeded] = await withClinic(db, clinic.id, (tx) => tx.select({ id: appointments.id }).from(appointments)
    .where(and(eq(appointments.clinicId, clinic.id), like(appointments.idempotencyKey, 'seed:%'))).limit(1));
  if (seeded) return { created: 0 };

  const directory = new PostgresPatientDirectory(db, cipher, 'seed');
  const pool = Object.values(opts.patientIds);
  for (const p of opts.extraPatients ?? DEMO_SCHEDULE_PATIENTS) {
    const [existing] = await withClinic(db, clinic.id, (tx) => tx.select({ id: patients.id }).from(patients)
      .where(and(eq(patients.clinicId, clinic.id), eq(patients.identityHash, cipher.hash(identityKey(clinic.id, p.firstName, p.lastName, p.dob, p.phone))))));
    pool.push(existing?.id ?? await directory.create(clinic.id, { ...p, gender: demoGender(p.firstName) }));
  }

  const rand = random(20260929);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const today = localDateOf(now, clinic.timezone);
  const monday = addDays(today, -((weekdayOf(today) + 6) % 7));
  const taken = await withClinic(db, clinic.id, (tx) => tx.select({ providerId: appointments.providerId, start: appointments.startsAt, end: appointments.endsAt })
    .from(appointments).where(and(eq(appointments.clinicId, clinic.id), eq(appointments.status, 'booked'))));
  const clashes = (providerId: string, start: Date, end: Date) => taken.some((b) => b.providerId === providerId && b.start < end && start < b.end);
  const upcoming = new Map<string, number>();
  for (const b of await withClinic(db, clinic.id, (tx) => tx.select({ patientId: appointments.patientId, start: appointments.startsAt })
    .from(appointments).where(and(eq(appointments.clinicId, clinic.id), eq(appointments.status, 'booked'))))) {
    if (b.start > now) upcoming.set(b.patientId, (upcoming.get(b.patientId) ?? 0) + 1);
  }
  // each patient's date of birth, so a pediatrician sees children and a doctor for adults sees adults
  const dobs = new Map((await withClinic(db, clinic.id, (tx) => tx.select({ id: patients.id, dob: patients.dobEnc }).from(patients).where(eq(patients.clinicId, clinic.id))))
    .map((r) => [r.id, cipher.decrypt(r.dob, phiContext(clinic.id, 'patients.dob'))]));
  /** Anyone the provider sees for a past visit; for an upcoming one, someone with fewer than two already, or nobody. */
  const patientFor = (start: Date, provider: Provider, date: string): string | null => {
    const seen = pool.filter((id) => seesAge(provider, ageOn(dobs.get(id) ?? '1980-01-01', date)));
    if (!seen.length) return null;
    if (start <= now) return pick(seen);
    const offset = Math.floor(rand() * seen.length);
    for (let i = 0; i < seen.length; i++) {
      const id = seen[(offset + i) % seen.length]!;
      if ((upcoming.get(id) ?? 0) < MAX_UPCOMING) return id;
    }
    return null;
  };

  const rows: (typeof appointments.$inferInsert)[] = [];
  for (let d = 0; d < 21; d++) {
    const date = addDays(monday, d);
    if (clinic.holidays.includes(date)) continue;
    for (const provider of clinic.providers) {
      for (const w of windowsOn(provider.hours ?? clinic.hours, weekdayOf(date))) {
        let m = toMinutes(w.open);
        while (m < toMinutes(w.close)) {
          // mostly sick visits, fewer physicals, the odd new patient
          const visitId = pick(provider.visitTypeIds.flatMap((id) => (id === 'vt_sick' ? [id, id, id] : id === 'vt_annual' ? [id, id] : [id])));
          const visit = clinic.visitTypes.find((v) => v.id === visitId)!;
          if (m + visit.minutes > toMinutes(w.close)) break;
          const start = zonedInstant(date, fromMinutes(m), clinic.timezone);
          const end = new Date(start.getTime() + visit.minutes * 60_000);
          const patientId = rand() < 0.6 && !clashes(provider.id, start, end) ? patientFor(start, provider, date) : null;
          if (patientId) {
            const cancelled = rand() < 0.06;
            const bookedBy = pick(opts.staffUserIds);
            const note = rand() < 0.15 ? pick(opts.notes ?? NOTES) : null;
            rows.push({
              clinicId: clinic.id, patientId, providerId: provider.id, visitTypeId: visit.id, startsAt: start, endsAt: end,
              idempotencyKey: `seed:${provider.id}:${start.toISOString()}`, createdByUserId: bookedBy,
              createdAt: new Date(Math.min(now.getTime(), start.getTime()) - Math.floor(rand() * 10 + 1) * 86_400_000),
              noteEnc: note ? cipher.encrypt(note, phiContext(clinic.id, 'appointments.note')) : null,
              ...(cancelled ? { status: 'cancelled' as const, cancelledByUserId: pick(opts.staffUserIds), cancelReason: pick(REASONS) } : {}),
            });
            if (!cancelled) {
              taken.push({ providerId: provider.id, start, end });
              if (start > now) upcoming.set(patientId, (upcoming.get(patientId) ?? 0) + 1);
            }
            m += visit.minutes;
          } else {
            m += 20; // a gap, the length of the shortest visit
          }
        }
      }
    }
  }
  await withClinic(db, clinic.id, async (tx) => { for (let i = 0; i < rows.length; i += 100) await tx.insert(appointments).values(rows.slice(i, i + 100)); });
  return { created: rows.length };
}
