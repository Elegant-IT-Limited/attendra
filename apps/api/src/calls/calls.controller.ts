// SPDX-License-Identifier: AGPL-3.0-only
import type { FrontDeskRepository } from '@attendra/db';
import { Controller, Get, Inject, NotFoundException, Param, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CallDetail, callCursor, CallList, Page } from '../contracts';
import { schemaOf } from '../http/openapi';
import { CurrentStaff, Requires, type Staff } from '../http/staff.guard';
import { FRONT_DESK } from '../http/tokens';
import { ZodPipe } from '../http/zod.pipe';

const isUuid = (s: string) => z.uuid().safeParse(s).success;

@ApiTags('calls')
@ApiCookieAuth()
@ApiParam({ name: 'clinicId', example: 'clinic_maple' })
@Controller('clinics/:clinicId/calls')
export class CallsController {
  constructor(@Inject(FRONT_DESK) private readonly desk: FrontDeskRepository) {}

  @Get()
  @Requires('calls:list')
  @ApiOperation({ summary: 'Recent calls, newest first. No patient data.' })
  @ApiOkResponse({ schema: schemaOf(CallList) })
  async list(@Param('clinicId') clinicId: string, @Query(new ZodPipe(Page)) page: z.infer<typeof Page>): Promise<CallList> {
    const calls = await this.desk.listCalls(clinicId, page);
    const last = calls.at(-1);
    return {
      calls: calls.map((c) => ({
        id: c.id, channel: c.channel, outcome: c.outcome, emergency: c.emergency, closeReason: c.closeReason, voiceSeconds: c.voiceSeconds, tools: c.tools, verified: c.verified,
        startedAt: c.startedAt.toISOString(), endedAt: c.endedAt?.toISOString() ?? null,
      })),
      next: calls.length === page.limit && last ? callCursor.encode(last) : null,
    };
  }

  @Get(':callId')
  @Requires('calls:read')
  @ApiOperation({ summary: 'One call with its transcript and tool actions. Audited as a PHI view.' })
  @ApiOkResponse({ schema: schemaOf(CallDetail) })
  @ApiNotFoundResponse()
  async get(@Param('clinicId') clinicId: string, @Param('callId') callId: string, @CurrentStaff() staff: Staff): Promise<CallDetail> {
    const call = isUuid(callId) ? await this.desk.getCall(clinicId, callId, staff.userId) : null;
    if (!call) throw new NotFoundException({ error: 'not_found' });
    return {
      ...call,
      startedAt: call.startedAt.toISOString(),
      endedAt: call.endedAt?.toISOString() ?? null,
      actions: call.actions.map((a) => ({ ...a, at: a.at.toISOString() })),
      appointments: call.appointments.map((a) => ({ ...a, startsAt: a.startsAt.toISOString() })),
    };
  }
}
