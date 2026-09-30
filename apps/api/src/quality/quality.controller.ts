// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, ClinicConfig, localDateOf, zonedInstant } from '@attendra/core';
import { type Database, type FrontDeskRepository, qualityRows } from '@attendra/db';
import { Controller, Get, Inject, NotFoundException, Param, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { Quality, QualityQuery } from '../contracts';
import { schemaOf } from '../http/openapi';
import { Requires } from '../http/staff.guard';
import { CLOCK, DB, FRONT_DESK } from '../http/tokens';
import { ZodPipe } from '../http/zod.pipe';
import { COST_PER_MINUTE } from '../overview/overview.controller';
import { qualityWeeks, weekStart } from './metrics';

@ApiTags('quality')
@ApiCookieAuth()
@ApiParam({ name: 'clinicId', example: 'clinic_maple' })
@Controller('clinics/:clinicId/quality')
export class QualityController {
  constructor(@Inject(DB) private readonly db: Database, @Inject(FRONT_DESK) private readonly desk: FrontDeskRepository, @Inject(CLOCK) private readonly now: () => Date) {}

  /** How the assistant did, week by week: containment, bookings, refusals, handovers, reviews, after-hours calls and cost. No patient data. */
  @Get()
  @Requires('quality:read')
  @ApiOperation({ summary: 'Weekly quality metrics, counted in the database. Codes and counts only.' })
  @ApiOkResponse({ schema: schemaOf(Quality) })
  async get(@Param('clinicId') clinicId: string, @Query(new ZodPipe(QualityQuery)) q: z.infer<typeof QualityQuery>): Promise<Quality> {
    const stored = await this.desk.settings(clinicId);
    if (!stored) throw new NotFoundException({ error: 'not_found' });
    const clinic = ClinicConfig.parse(stored);
    const now = this.now();
    const first = addDays(weekStart(localDateOf(now, clinic.timezone)), -7 * (q.weeks - 1));
    const rows = await qualityRows(this.db, clinicId, zonedInstant(first, '00:00', clinic.timezone), new Date(now.getTime() + 86_400_000));
    return { weeks: qualityWeeks(rows, clinic, now, q.weeks, COST_PER_MINUTE), costPerMinute: COST_PER_MINUTE };
  }
}
