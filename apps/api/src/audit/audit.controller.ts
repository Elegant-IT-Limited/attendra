// SPDX-License-Identifier: AGPL-3.0-only
import type { FrontDeskRepository } from '@attendra/db';
import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { AuditList, AuditPage } from '../contracts';
import { schemaOf } from '../http/openapi';
import { Requires } from '../http/staff.guard';
import { FRONT_DESK } from '../http/tokens';
import { ZodPipe } from '../http/zod.pipe';

@ApiTags('audit')
@ApiCookieAuth()
@ApiParam({ name: 'clinicId', example: 'clinic_maple' })
@Controller('clinics/:clinicId/audit')
export class AuditController {
  constructor(@Inject(FRONT_DESK) private readonly desk: FrontDeskRepository) {}

  @Get()
  @Requires('audit:read')
  @ApiOperation({ summary: 'Every PHI view and every write, newest first' })
  @ApiOkResponse({ schema: schemaOf(AuditList) })
  async list(@Param('clinicId') clinicId: string, @Query(new ZodPipe(AuditPage)) page: z.infer<typeof AuditPage>): Promise<AuditList> {
    const entries = await this.desk.auditTrail(clinicId, { beforeId: page.before, limit: page.limit });
    const last = entries.at(-1);
    return {
      entries: entries.map((e) => ({ ...e, at: e.at.toISOString() })),
      next: entries.length === page.limit && last ? last.id : null,
    };
  }
}
