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
  @ApiOperation({ summary: 'The hosting plan, if any, and the phone minutes used in its month. Counts only, for every member.' })
  @ApiOkResponse({ schema: schemaOf(ClinicPlan) })
  async get(@Param('clinicId') clinicId: string): Promise<ClinicPlan> {
    const parsed = HostingPlan.safeParse(await hostingPlanOf(this.db, clinicId));
    if (!parsed.success) return { plan: null, minutesUsed: null };
    const plan = parsed.data;
    // rounded up to the minute once, as the hosting layer bills them
    const minutesUsed = plan.status !== 'trial' && plan.periodStart
      ? Math.ceil((await phoneUsage(this.db, clinicId, new Date(plan.periodStart), this.now())).seconds / 60)
      : null;
    return { plan, minutesUsed };
  }
}
