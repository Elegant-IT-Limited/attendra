// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, type ClinicConfig, DEMO_CLINIC, fromMinutes, localDateOf, toMinutes, weekdayOf, windowsOn, zonedInstant } from '@attendra/core';
import { and, eq, like } from 'drizzle-orm';
import { type Database, withClinic } from './client';
import { type PhiCipher, phiContext } from './crypto';
import { phoneKey, PostgresPatientDirectory } from './repositories/patients';
import { appointments, patients } from './schema';

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
].map(([firstName, lastName, dob], i) => ({ firstName: firstName!, lastName: lastName!, dob: dob!, phone: `+1720555${String(110 + i).padStart(4, '0')}` }));

/** The Dhaka demo clinic's walk-in register: invented names, +880 10 numbers no operator issues. */
export const DHANMONDI_SCHEDULE_PATIENTS = [
  ['Nasima', 'Begum', '1963-04-11'], ['Rafiq', 'Islam', '1975-09-02'], ['Shirin', 'Sultana', '1990-01-19'], ['Mahbub', 'Alam', '1984-06-27'],
  ['Farzana', 'Haque', '1997-03-08'], ['Jamal', 'Uddin', '1958-12-30'], ['Laila', 'Chowdhury', '1981-07-14'], ['Arif', 'Hasan', '2002-10-05'],
  ['Sumaiya', 'Noor', '1995-05-23'], ['Kamrul', 'Ahsan', '1970-02-16'], ['Rokeya', 'Parvin', '1966-08-09'], ['Tanvir', 'Ahmed', '1989-11-21'],
  ['Moushumi', 'Das', '1987-04-30'], ['Imran', 'Kabir', '1979-01-07'], ['Sadia', 'Islam', '2000-09-12'], ['Habib', 'Mia', '1955-06-18'],
].map(([firstName, lastName, dob], i) => ({ firstName: firstName!, lastName: lastName!, dob: dob!, phone: `+88010000002${String(10 + i).padStart(2, '0')}` }));

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

const NOTES = ['Prefers a morning reminder call.', 'Bring the list of current medications.', 'Wheelchair access needed.', 'Interpreter: Spanish.', 'Follow-up from last visit.'];
const REASONS = ['patient_asked', 'patient_asked', 'clinic_asked', 'booked_in_error'] as const;

/**
 * Two weeks of a working calendar around `now`: from the Monday of this week to two
 * weeks out, about 60 percent of each provider's bookable time filled, a few
 * cancellations, and a note here and there. Staff made these bookings; the ones the
 * assistant made come from the demo calls themselves and are left where they are.
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
      .where(and(eq(patients.clinicId, clinic.id), eq(patients.phoneHash, cipher.hash(phoneKey(clinic.id, p.phone))))));
    pool.push(existing?.id ?? await directory.create(clinic.id, p));
  }

  const rand = random(20260929);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const today = localDateOf(now, clinic.timezone);
  const monday = addDays(today, -((weekdayOf(today) + 6) % 7));
  const taken = await withClinic(db, clinic.id, (tx) => tx.select({ providerId: appointments.providerId, start: appointments.startsAt, end: appointments.endsAt })
    .from(appointments).where(and(eq(appointments.clinicId, clinic.id), eq(appointments.status, 'booked'))));
  const clashes = (providerId: string, start: Date, end: Date) => taken.some((b) => b.providerId === providerId && b.start < end && start < b.end);

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
          if (rand() < 0.6 && !clashes(provider.id, start, end)) {
            const cancelled = rand() < 0.06;
            const bookedBy = pick(opts.staffUserIds);
            const note = rand() < 0.15 ? pick(opts.notes ?? NOTES) : null;
            rows.push({
              clinicId: clinic.id, patientId: pick(pool), providerId: provider.id, visitTypeId: visit.id, startsAt: start, endsAt: end,
              idempotencyKey: `seed:${provider.id}:${start.toISOString()}`, createdByUserId: bookedBy,
              createdAt: new Date(Math.min(now.getTime(), start.getTime()) - Math.floor(rand() * 10 + 1) * 86_400_000),
              noteEnc: note ? cipher.encrypt(note, phiContext(clinic.id, 'appointments.note')) : null,
              ...(cancelled ? { status: 'cancelled' as const, cancelledByUserId: pick(opts.staffUserIds), cancelReason: pick(REASONS) } : {}),
            });
            if (!cancelled) taken.push({ providerId: provider.id, start, end });
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
