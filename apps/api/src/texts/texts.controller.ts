// SPDX-License-Identifier: AGPL-3.0-only
import type { FrontDeskRepository } from '@attendra/db';
import { Controller, ForbiddenException, Get, Inject, Param, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { can, type Permission } from '../access';
import { TextList, TextQuery } from '../contracts';
import { schemaOf } from '../http/openapi';
import { CurrentStaff, Requires, type Staff } from '../http/staff.guard';
import { FRONT_DESK } from '../http/tokens';
import { ZodPipe } from '../http/zod.pipe';

const iso = (d: Date | null) => d?.toISOString() ?? null;

/** Whether a text went, for staff: on the call, the request, the pet or patient, the visit. Never its words or the number. */
@ApiTags('texts')
@ApiCookieAuth()
@ApiParam({ name: 'clinicId', example: 'clinic_maple' })
@Controller('clinics/:clinicId/texts')
export class TextsController {
  constructor(@Inject(FRONT_DESK) private readonly desk: FrontDeskRepository) {}

  @Get()
  @Requires('calls:read')
  @ApiOperation({ summary: 'The texts about one call, request or appointment, to one pet\'s or patient\'s household (20), or the clinic\'s newest (50, all or not sent): kind, sent, delivered or why not, the words that went out (while call records are kept) and what each belongs to. Owners, managers and front desk; every read is audited.' })
  @ApiOkResponse({ schema: schemaOf(TextList) })
  async list(@Param('clinicId') clinicId: string, @Query(new ZodPipe(TextQuery)) q: z.infer<typeof TextQuery>, @CurrentStaff() staff: Staff): Promise<TextList> {
    // the words that went out are caller data: the roles that read calls and records (never a viewer)
    const needs: Permission = q.callId ? 'calls:read' : q.taskId ? 'tasks:read' : 'patients:read';
    if (!staff.role || !can(staff.role, needs)) throw new ForbiddenException();
    const rows = await this.desk.texts(clinicId, q, staff.userId);
    return {
      texts: rows.map((r) => ({
        ...r, kind: r.kind as TextList['texts'][number]['kind'], status: r.status as TextList['texts'][number]['status'],
        createdAt: r.createdAt.toISOString(), sentAt: iso(r.sentAt), deliveredAt: iso(r.deliveredAt), appointmentStartsAt: iso(r.appointmentStartsAt),
      })),
    };
  }
}
