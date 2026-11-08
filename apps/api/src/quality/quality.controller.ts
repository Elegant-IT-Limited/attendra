// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, ClinicConfig, localDateOf, zonedInstant } from '@attendra/core';
import { clinicSince, type Database, type FrontDeskRepository, qualityRows, testCallStarts, visitsDue } from '@attendra/db';
import { Controller, Get, Inject, NotFoundException, Param, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { Quality, QualityQuery } from '../contracts';
import { schemaOf } from '../http/openapi';
import { Requires } from '../http/staff.guard';
import { CLOCK, DB, FRONT_DESK } from '../http/tokens';
import { ZodPipe } from '../http/zod.pipe';
import { COST_PER_MINUTE } from '../overview/overview.controller';
import { qualityWeeks, weeksSince, weekStart } from './metrics';

@ApiTags('quality')
@ApiCookieAuth()
@ApiParam({ name: 'clinicId', example: 'clinic_maple' })
@Controller('clinics/:clinicId/quality')
export class QualityController {
  constructor(@Inject(DB) private readonly db: Database, @Inject(FRONT_DESK) private readonly desk: FrontDeskRepository, @Inject(CLOCK) private readonly now: () => Date) {}

  /**
   * How the assistant did, week by week: containment, bookings, refusals, handovers,
   * reviews, after-hours calls and cost, and the visits the desk marked no-shows. No patient data. Real phone calls only, with
   * each week's browser test calls counted as left out. The weeks go back to the
   * clinic's sign-up week, `weeks` at most.
   */
  @Get()
  @Requires('quality:read')
  @ApiOperation({ summary: 'Weekly quality metrics, counted in the database. Codes and counts only.' })
  @ApiOkResponse({ schema: schemaOf(Quality) })
  async get(@Param('clinicId') clinicId: string, @Query(new ZodPipe(QualityQuery)) q: z.infer<typeof QualityQuery>): Promise<Quality> {
    const stored = await this.desk.settings(clinicId);
    if (!stored) throw new NotFoundException({ error: 'not_found' });
    const clinic = ClinicConfig.parse(stored);
    const now = this.now();
    const weeks = weeksSince(await clinicSince(this.db, clinicId), now, clinic.timezone, q.weeks);
    const from = zonedInstant(addDays(weekStart(localDateOf(now, clinic.timezone)), -7 * (weeks - 1)), '00:00', clinic.timezone);
    const to = new Date(now.getTime() + 86_400_000);
    const [rows, tests, visits] = await Promise.all([qualityRows(this.db, clinicId, from, to), testCallStarts(this.db, clinicId, from, to), visitsDue(this.db, clinicId, from, to, now)]);
    return { weeks: qualityWeeks(rows, clinic, now, weeks, COST_PER_MINUTE, tests, visits), costPerMinute: COST_PER_MINUTE };
  }
}
