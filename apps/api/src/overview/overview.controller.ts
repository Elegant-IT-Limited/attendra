// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, ClinicConfig, isOpen, localDateOf, zonedInstant } from '@attendra/core';
import type { FrontDeskRepository } from '@attendra/db';
import { Controller, Get, Inject, NotFoundException, Param, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { Overview, OverviewQuery } from '../contracts';
import { schemaOf } from '../http/openapi';
import { Requires } from '../http/staff.guard';
import { CLOCK, FRONT_DESK } from '../http/tokens';
import { ZodPipe } from '../http/zod.pipe';

/** GPT-Live's price for a minute of a call, as the docs quote it. An estimate, for a sense of scale. */
export const COST_PER_MINUTE = 0.05;

type Activity = Awaited<ReturnType<FrontDeskRepository['activity']>>;

function summarize(a: Activity, clinic: ClinicConfig, from: Date) {
  const calls = a.calls.filter((c) => c.startedAt >= from);
  const count = (outcome: string) => calls.filter((c) => c.outcome === outcome).length;
  const seconds = calls.reduce((n, c) => n + c.voiceSeconds, 0);
  const talkMinutes = Math.round(seconds / 6) / 10;
  return {
    callsAnswered: calls.length,
    booked: count('booked'),
    rescheduled: count('rescheduled'),
    cancelled: count('cancelled'),
    requestsTaken: a.requests.filter((d) => d >= from).length,
    handedToStaff: calls.filter((c) => c.outcome === 'transferred' || c.closeReason === 'transferred').length,
    afterHours: calls.filter((c) => !isOpen(clinic, c.startedAt)).length,
    talkMinutes,
    estimatedCost: Math.round(talkMinutes * COST_PER_MINUTE * 100) / 100,
  };
}

@ApiTags('overview')
@ApiCookieAuth()
@ApiParam({ name: 'clinicId', example: 'clinic_maple' })
@Controller('clinics/:clinicId/overview')
export class OverviewController {
  constructor(@Inject(FRONT_DESK) private readonly desk: FrontDeskRepository, @Inject(CLOCK) private readonly now: () => Date) {}

  @Get()
  @Requires('calls:list')
  @ApiOperation({ summary: 'What the assistant did today and over the last days, counted in the database. Counts only; no patient data.' })
  @ApiOkResponse({ schema: schemaOf(Overview) })
  async get(@Param('clinicId') clinicId: string, @Query(new ZodPipe(OverviewQuery)) q: z.infer<typeof OverviewQuery>): Promise<Overview> {
    const stored = await this.desk.settings(clinicId);
    if (!stored) throw new NotFoundException({ error: 'not_found' });
    const clinic = ClinicConfig.parse(stored);
    const now = this.now();
    const midnight = zonedInstant(localDateOf(now, clinic.timezone), '00:00', clinic.timezone);
    // far enough back for both the rolling period and the first day the trend lines show
    const firstDay = zonedInstant(addDays(localDateOf(now, clinic.timezone), 1 - q.days), '00:00', clinic.timezone);
    const since = new Date(Math.min(midnight.getTime(), firstDay.getTime(), now.getTime() - q.days * 86_400_000));
    const activity = await this.desk.activity(clinicId, since);
    const today = localDateOf(now, clinic.timezone);
    const daily = Array.from({ length: q.days }, (_, i) => addDays(today, i - q.days + 1)).map((date) => {
      const onDay = (d: Date) => localDateOf(d, clinic.timezone) === date;
      const calls = activity.calls.filter((c) => onDay(c.startedAt));
      return { date, calls: calls.length, booked: calls.filter((c) => c.outcome === 'booked').length, requests: activity.requests.filter(onDay).length };
    });
    return {
      days: q.days,
      costPerMinute: COST_PER_MINUTE,
      today: summarize(activity, clinic, midnight),
      period: summarize(activity, clinic, new Date(now.getTime() - q.days * 86_400_000)),
      daily,
    };
  }
}
