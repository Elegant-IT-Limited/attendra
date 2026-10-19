// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, ageOn, awayOn, awayWindows, ClinicConfig, type EventSink, localDateOf, localParts, normalizeName, specialDayOf, toMinutes, zonedInstant } from '@attendra/core';
import { appointmentFacts, type Database, type FrontDeskRepository, nameMatches, type ScheduleEntry, type ScheduleRepository } from '@attendra/db';
import { openSlots, type SlotProblem, type StaffChange, type StaffScheduler } from '@attendra/scheduling';
import { Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Post, Query, UnprocessableEntityException } from '@nestjs/common';
import { can } from '../access';
import { ApiBody, ApiConflictResponse, ApiCookieAuth, ApiCreatedResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  type Appointment, AppointmentChange, AppointmentDetail, BookAppointment, type BookedBy, CancelAppointment, CancelledList, CancelledQuery, RescheduleAppointment, Schedule,
  ScheduleConflicts, ScheduleQuery, SlotList, SlotQuery,
} from '../contracts';
import { schemaOf } from '../http/openapi';
import { CurrentStaff, Requires, type Staff } from '../http/staff.guard';
import { CLOCK, DB, EVENTS, FRONT_DESK, SCHEDULE, STAFF_SCHEDULER } from '../http/tokens';
import { ZodPipe } from '../http/zod.pipe';

const isUuid = (s: string) => z.uuid().safeParse(s).success;

/** What the front desk is told when a time cannot be booked. */
const REFUSED: Record<SlotProblem | 'cancelled' | 'just_cancelled', string> = {
  taken: 'That time was just taken. Pick another one.',
  closed: 'That time is outside the provider\'s hours, or not on the visit\'s time grid. The front desk can squeeze it in with Override.',
  holiday: 'The clinic is closed that day. The front desk can squeeze it in with Override.',
  away: 'The provider is away then. The front desk can squeeze it in with Override.',
  past: 'That time has already passed.',
  not_offered: 'This provider does not do that visit type.',
  unknown_provider: 'There is no such provider at this clinic.',
  unknown_visit_type: 'There is no such visit type at this clinic.',
  cancelled: 'This appointment is cancelled. Book a new one instead.',
  just_cancelled: 'This appointment was just cancelled. Refresh to see the schedule as it is now.',
};

const by = (b: import('@attendra/db').BookedBy | null): BookedBy | null =>
  !b ? null : b.kind === 'assistant' ? { kind: 'assistant', callId: b.callId } : { kind: 'staff', name: b.name };

const toAppointment = (a: ScheduleEntry): Appointment => ({
  id: a.id, patientId: a.patientId, patientName: a.patientName, providerId: a.providerId, visitTypeId: a.visitTypeId,
  startsAt: a.startsAt.toISOString(), endsAt: a.endsAt.toISOString(), status: a.status,
  cancelReason: a.cancelReason as Appointment['cancelReason'], bookedBy: by(a.bookedBy)!, cancelledBy: by(a.cancelledBy), createdAt: a.createdAt.toISOString(),
  overrideReason: a.overrideReason, confirmedAt: a.confirmedAt?.toISOString() ?? null, confirmedVia: a.confirmedVia, reminderSentAt: a.reminderSentAt?.toISOString() ?? null,
});

@ApiTags('schedule')
@ApiCookieAuth()
@ApiParam({ name: 'clinicId', example: 'clinic_maple' })
@Controller('clinics/:clinicId/appointments')
export class AppointmentsController {
  constructor(
    @Inject(FRONT_DESK) private readonly desk: FrontDeskRepository,
    @Inject(SCHEDULE) private readonly schedule: ScheduleRepository,
    @Inject(STAFF_SCHEDULER) private readonly scheduler: StaffScheduler,
    @Inject(CLOCK) private readonly now: () => Date,
    @Inject(DB) private readonly db: Database,
    @Inject(EVENTS) private readonly events: EventSink,
  ) {}

  @Get()
  @Requires('schedule:read')
  @ApiOperation({ summary: 'Appointments that start on the given clinic-time days: booked, cancelled, or both. Audited as one view of the range.' })
  @ApiOkResponse({ schema: schemaOf(Schedule) })
  async list(@Param('clinicId') clinicId: string, @Query(new ZodPipe(ScheduleQuery)) q: z.infer<typeof ScheduleQuery>, @CurrentStaff() staff: Staff): Promise<Schedule> {
    const clinic = await this.clinic(clinicId);
    const from = zonedInstant(q.from, '00:00', clinic.timezone);
    const to = zonedInstant(addDays(q.from, q.days), '00:00', clinic.timezone);
    const rows = await this.schedule.range(clinicId, { from, to, providerId: q.providerId, status: q.status, label: `${q.from}+${q.days}` }, staff.userId);
    return { from: q.from, days: q.days, appointments: rows.map(toAppointment) };
  }

  /** A POST, not a GET: the name typed to narrow it is a patient's, and URLs end up in logs. */
  @Post('cancelled')
  @HttpCode(200)
  @Requires('schedule:read')
  @ApiOperation({ summary: 'Cancelled visits as a history list: by visit day or by when they were cancelled, newest or oldest first, optionally by patient name. At most 200. Audited as one view.' })
  @ApiBody({ schema: schemaOf(CancelledQuery) })
  @ApiOkResponse({ schema: schemaOf(CancelledList) })
  async cancelled(@Param('clinicId') clinicId: string, @Body(new ZodPipe(CancelledQuery)) q: z.infer<typeof CancelledQuery>, @CurrentStaff() staff: Staff): Promise<CancelledList> {
    if (q.to < q.from) throw this.invalid('to', 'the last day is before the first');
    const clinic = await this.clinic(clinicId);
    const words = q.q ? normalizeName(q.q).split(' ').filter(Boolean) : [];
    const { entries, truncated } = await this.schedule.cancelled(clinicId, {
      from: zonedInstant(q.from, '00:00', clinic.timezone), to: zonedInstant(addDays(q.to, 1), '00:00', clinic.timezone),
      providerId: q.providerId, sort: q.sort, order: q.order, label: `${q.from}..${q.to}`,
      match: words.length ? (name) => { const [first = '', ...rest] = name.split(' '); return nameMatches(words, { firstName: first, lastName: rest.join(' ') }); } : undefined,
    }, staff.userId);
    return { appointments: entries.map((e) => ({ ...toAppointment(e), cancelledAt: e.cancelledAt.toISOString() })), truncated };
  }

  @Get('slots')
  @Requires('schedule:read')
  @ApiOperation({ summary: 'Open times for one visit type, by the same rules the assistant books with. No patient data.' })
  @ApiOkResponse({ schema: schemaOf(SlotList) })
  async slots(@Param('clinicId') clinicId: string, @Query(new ZodPipe(SlotQuery)) q: z.infer<typeof SlotQuery>): Promise<SlotList> {
    const clinic = await this.clinic(clinicId);
    if (!clinic.visitTypes.some((v) => v.id === q.visitTypeId)) throw this.invalid('visitTypeId', 'unknown visit type');
    if (q.providerId && !clinic.providers.some((p) => p.id === q.providerId)) throw this.invalid('providerId', 'unknown provider');
    const now = this.now();
    const today = localDateOf(now, clinic.timezone);
    const fit = q.patientId ? await this.desk.bookingFit(clinicId, q.patientId) : null;
    if (q.patientId && !fit) throw this.invalid('patientId', 'unknown patient');
    const from = q.from && q.from > today ? q.from : today;
    const busy = await this.desk.busy(clinicId, {
      from: zonedInstant(from, '00:00', clinic.timezone), to: zonedInstant(addDays(from, q.days), '00:00', clinic.timezone), except: q.excluding,
    });
    // every opening in the days asked for: the picker shows them by day, and a cap would drop the last days
    const slots = openSlots(clinic, busy, { visitTypeId: q.visitTypeId, providerId: q.providerId, from, days: q.days, partOfDay: q.partOfDay, now, limit: 5000,
      patient: fit ? { age: ageOn(fit.dob, today), isNew: fit.isNew } : undefined });
    return { slots: slots.map((s) => ({ providerId: s.providerId, visitTypeId: s.visitTypeId, startsAt: s.start.toISOString(), endsAt: s.end.toISOString() })) };
  }

  /**
   * Visits still booked on a day their provider is now away, or the clinic now closed
   * for a holiday: what a change to days off or holidays left behind. Counts by day and
   * provider only, so no patient data and no audit row.
   */
  @Get('conflicts')
  @Requires('schedule:read')
  @ApiOperation({ summary: 'Booked visits on a provider\'s days off or a holiday, from today: counts by day and provider. No patient data.' })
  @ApiOkResponse({ schema: schemaOf(ScheduleConflicts) })
  async conflicts(@Param('clinicId') clinicId: string): Promise<ScheduleConflicts> {
    const clinic = await this.clinic(clinicId);
    const now = this.now();
    const today = localDateOf(now, clinic.timezone);
    const booked = await this.desk.busy(clinicId, { from: now, to: zonedInstant(addDays(today, 366), '00:00', clinic.timezone) });
    const found = new Map<string, { date: string; providerId: string; reason: 'holiday' | 'away'; count: number }>();
    for (const b of booked) {
      if (b.start < now) continue;
      const date = localDateOf(b.start, clinic.timezone);
      const provider = clinic.providers.find((p) => p.id === b.providerId);
      const special = specialDayOf(clinic, date);
      const minutes = localParts(b.start, clinic.timezone).minutes;
      const end = minutes + Math.round((b.end.getTime() - b.start.getTime()) / 60_000);
      // closed all day, or a special day whose hours no longer hold the whole visit
      const closedDay = special
        ? !special.windows.some((w) => toMinutes(w.open) <= minutes && end <= toMinutes(w.close))
        : clinic.holidays.includes(date);
      // a booking that overlaps a part-day absence counts too
      const awayThen = !!provider && (awayOn(provider, date) || awayWindows(provider, date).some((a) => minutes < a.end && end > a.start));
      const reason = closedDay ? 'holiday' : awayThen ? 'away' : null;
      if (!reason) continue;
      const key = `${date}|${b.providerId}`;
      const entry = found.get(key) ?? { date, providerId: b.providerId, reason, count: 0 };
      entry.count++;
      found.set(key, entry);
    }
    return { conflicts: [...found.values()].sort((a, b) => a.date.localeCompare(b.date)) };
  }

  @Get(':appointmentId')
  @Requires('schedule:read')
  @ApiOperation({ summary: 'One appointment with the patient\'s name, date of birth and phone. Audited as a PHI view.' })
  @ApiOkResponse({ schema: schemaOf(AppointmentDetail) })
  @ApiNotFoundResponse()
  async get(@Param('clinicId') clinicId: string, @Param('appointmentId') id: string, @CurrentStaff() staff: Staff): Promise<AppointmentDetail> {
    const a = isUuid(id) ? await this.schedule.appointment(clinicId, id, staff.userId) : null;
    if (!a) throw new NotFoundException({ error: 'not_found' });
    return {
      ...toAppointment(a), note: a.note, updatedAt: a.updatedAt.toISOString(),
      patient: { id: a.patient.id, name: `${a.patient.firstName} ${a.patient.lastName}`, dob: a.patient.dob, phone: a.patient.phone },
    };
  }

  @Post()
  @HttpCode(201)
  @Requires('schedule:write')
  @ApiOperation({ summary: 'Book an appointment for a patient. Idempotent by key. Audited.' })
  @ApiBody({ schema: schemaOf(BookAppointment) })
  @ApiCreatedResponse({ schema: schemaOf(AppointmentChange) })
  @ApiConflictResponse({ description: 'The time cannot be booked; `reason` says why' })
  async book(@Param('clinicId') clinicId: string, @Body(new ZodPipe(BookAppointment)) body: z.infer<typeof BookAppointment>, @CurrentStaff() staff: Staff): Promise<AppointmentChange> {
    const clinic = await this.clinic(clinicId);
    this.mayOverride(body.override, staff);
    return this.announce(clinicId, 'appointment.booked', this.answer(await this.scheduler.book(clinic, { ...body, start: new Date(body.startsAt), overrideReason: body.override ? body.overrideReason : null }, staff.userId)));
  }

  @Post(':appointmentId/reschedule')
  @HttpCode(200)
  @Requires('schedule:write')
  @ApiOperation({ summary: 'Move a booking to another time, and optionally another provider. Moving it where it already is changes nothing. Audited.' })
  @ApiBody({ schema: schemaOf(RescheduleAppointment) })
  @ApiOkResponse({ schema: schemaOf(AppointmentChange) })
  @ApiConflictResponse({ description: 'The new time cannot be booked; `reason` says why' })
  async reschedule(@Param('clinicId') clinicId: string, @Param('appointmentId') id: string, @Body(new ZodPipe(RescheduleAppointment)) body: z.infer<typeof RescheduleAppointment>, @CurrentStaff() staff: Staff): Promise<AppointmentChange> {
    if (!isUuid(id)) throw new NotFoundException({ error: 'not_found' });
    const clinic = await this.clinic(clinicId);
    this.mayOverride(body.override, staff);
    return this.announce(clinicId, 'appointment.rescheduled', this.answer(await this.scheduler.reschedule(clinic, id, { start: new Date(body.startsAt), providerId: body.providerId, overrideReason: body.override ? body.overrideReason : null }, staff.userId)));
  }

  @Post(':appointmentId/cancel')
  @HttpCode(200)
  @Requires('schedule:write')
  @ApiOperation({ summary: 'Cancel a booking, with an optional reason. Cancelling it twice changes nothing. Audited.' })
  @ApiBody({ schema: schemaOf(CancelAppointment) })
  @ApiOkResponse({ schema: schemaOf(AppointmentChange) })
  async cancel(@Param('clinicId') clinicId: string, @Param('appointmentId') id: string, @Body(new ZodPipe(CancelAppointment)) body: z.infer<typeof CancelAppointment>, @CurrentStaff() staff: Staff): Promise<AppointmentChange> {
    if (!isUuid(id)) throw new NotFoundException({ error: 'not_found' });
    const clinic = await this.clinic(clinicId);
    return this.announce(clinicId, 'appointment.cancelled', this.answer(await this.scheduler.cancel(clinic, id, { reason: body.reason }, staff.userId)));
  }

  /** Tells the clinic's webhooks about a change that happened (not a repeat of one), with ids and times only. */
  private async announce(clinicId: string, type: 'appointment.booked' | 'appointment.rescheduled' | 'appointment.cancelled', change: AppointmentChange): Promise<AppointmentChange> {
    if (change.status !== 'done') return change;
    const a = await appointmentFacts(this.db, clinicId, change.appointmentId);
    if (!a) return change;
    const data: Record<string, string | null> = type === 'appointment.cancelled'
      ? { appointmentId: a.appointmentId, patientId: a.patientId, by: 'staff', callId: null, reason: a.cancelReason }
      : { appointmentId: a.appointmentId, patientId: a.patientId, providerId: a.providerId, visitTypeId: a.visitTypeId, startsAt: a.startsAt, endsAt: a.endsAt, by: 'staff', callId: null };
    // a staff move keeps the appointment, so there is no previous one
    if (type === 'appointment.rescheduled') data.previousAppointmentId = null;
    // each move is its own event, even back to a time the appointment had before
    await this.events.emit(clinicId, { type, key: type === 'appointment.rescheduled' ? `${a.appointmentId}|${a.startsAt}|${a.updatedAt}` : a.appointmentId, data });
    return change;
  }

  private mayOverride(override: boolean, staff: Staff) {
    if (override && (!staff.role || !can(staff.role, 'schedule:override'))) throw new ForbiddenException({ error: 'forbidden', message: 'Your role cannot book outside the hours.' });
  }

  private answer(result: StaffChange): AppointmentChange {
    if (result.status === 'not_found') throw new NotFoundException({ error: 'not_found' });
    if (result.status === 'refused') {
      if (result.reason === 'patient_busy') throw new ConflictException({ error: 'slot_unavailable', reason: 'patient_busy', message: `${result.patientName} already has an appointment then.` });
      if (result.reason === 'idempotency_mismatch') {
        throw new ConflictException({ error: 'idempotency_mismatch', message: 'This booking key was already used for a different booking. Start a new booking.' });
      }
      if (result.reason === 'unknown_provider' || result.reason === 'unknown_visit_type') {
        throw this.invalid(result.reason === 'unknown_provider' ? 'providerId' : 'visitTypeId', REFUSED[result.reason]);
      }
      throw new ConflictException({ error: 'slot_unavailable', reason: result.reason, message: REFUSED[result.reason] });
    }
    return { appointmentId: result.appointmentId, status: result.status };
  }

  private invalid(path: string, message: string) {
    return new UnprocessableEntityException({ error: 'invalid_request', issues: [{ path, message }] });
  }

  private async clinic(clinicId: string) {
    const stored = await this.desk.settings(clinicId);
    if (!stored) throw new NotFoundException({ error: 'not_found' });
    return ClinicConfig.parse(stored);
  }
}
