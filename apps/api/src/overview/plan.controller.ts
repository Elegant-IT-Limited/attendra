// SPDX-License-Identifier: AGPL-3.0-only
import { type Database, hostingPlanOf, phoneUsage } from '@attendra/db';
import { Controller, Get, Inject, Param } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ClinicPlan, HostingPlan } from '../contracts';
import { schemaOf } from '../http/openapi';
import { Requires } from '../http/staff.guard';
import { CLOCK, DB } from '../http/tokens';

@ApiTags('overview')
@ApiCookieAuth()
@ApiParam({ name: 'clinicId', example: 'clinic_maple' })
@Controller('clinics/:clinicId/plan')
export class PlanController {
  constructor(@Inject(DB) private readonly db: Database, @Inject(CLOCK) private readonly now: () => Date) {}

  @Get()
  @Requires('calls:list')
  @ApiOperation({ summary: 'The hosting plan, if any, and the phone minutes and texts used in its month. Counts only, for every member.' })
  @ApiOkResponse({ schema: schemaOf(ClinicPlan) })
  async get(@Param('clinicId') clinicId: string): Promise<ClinicPlan> {
    const parsed = HostingPlan.safeParse(await hostingPlanOf(this.db, clinicId));
    if (!parsed.success) return { plan: null, minutesUsed: null, textsUsed: null };
    const plan = parsed.data;
    if (plan.status === 'trial' || !plan.periodStart) return { plan, minutesUsed: null, textsUsed: null };
    const usage = await phoneUsage(this.db, clinicId, new Date(plan.periodStart), this.now());
    // minutes rounded up once, as the hosting layer bills them; texts as the carrier took them
    return { plan, minutesUsed: Math.ceil(usage.seconds / 60), textsUsed: usage.texts };
  }
}
