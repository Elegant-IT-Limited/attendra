// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, type ClinicConfig, localDateOf, newlyStranded, zonedInstant } from '@attendra/core';
import type { FrontDeskRepository, ScheduleRepository, Tx } from '@attendra/db';
import { ConflictException } from '@nestjs/common';
import { can } from '../access';
import type { StrandedVisits } from '../contracts';
import type { Staff } from '../http/staff.guard';

/** How far ahead a change of hours is checked against what is booked: as far as anyone books. */
export const STRANDED_CHECK_DAYS = 366;

export type StrandedHit = Awaited<ReturnType<typeof strandedBy>>[number];

/**
 * The booked visits to come that a change of settings would leave outside any bookable time, and that fit before it
 * (core newlyStranded: the same rule as the Schedule's warning). No patient data.
 */
export async function strandedBy(desk: FrontDeskRepository, clinicId: string, before: ClinicConfig, after: ClinicConfig, now: Date, tx?: Tx) {
  const today = localDateOf(now, after.timezone);
  const booked = await desk.bookedAhead(clinicId, { from: now, to: zonedInstant(addDays(today, STRANDED_CHECK_DAYS), '00:00', after.timezone) }, tx);
  return newlyStranded(before, after, booked);
}

/** Whether a save says to keep the visits it strands where they are: `?keepStranded=true`. */
export const keeps = (q: { keepStranded?: 'true' | 'false' }) => q.keepStranded === 'true';

/**
 * The 409 that stops the save: the "move or keep" list, each visit with the patient's name as the schedule shows it
 * to this person (audited as one view), or without names for a role that sees the schedule without them.
 */
export async function strandedConflict(schedule: ScheduleRepository, clinicId: string, hits: StrandedHit[], staff: Staff): Promise<ConflictException> {
  const named = !!staff.role && can(staff.role, 'schedule:read');
  const reasons = new Map(hits.map((h) => [h.id, h.reason]));
  const entries = await schedule.visits(clinicId, hits.map((h) => h.id), { label: 'stranded', named }, staff.userId);
  const one = entries.length === 1;
  const body: StrandedVisits = {
    error: 'strands_visits',
    message: `${entries.length} booked ${one ? 'visit' : 'visits'} would be outside the hours. Move ${one ? 'it' : 'them'} first, or save again with keepStranded=true to keep ${one ? 'it where it is' : 'them where they are'}.`,
    visits: entries.map((e) => ({
      appointmentId: e.id, startsAt: e.startsAt.toISOString(), endsAt: e.endsAt.toISOString(), providerId: e.providerId, visitTypeId: e.visitTypeId,
      patientName: e.patientName, reason: reasons.get(e.id)!,
    })),
  };
  return new ConflictException(body);
}
