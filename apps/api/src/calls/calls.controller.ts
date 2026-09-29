// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, ClinicConfig, zonedInstant } from '@attendra/core';
import type { FrontDeskRepository, PatientRecords } from '@attendra/db';
import { Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { can } from '../access';
import { CallDetail, callCursor, CallList, CallQuery, CallSearch } from '../contracts';
import { schemaOf } from '../http/openapi';
import { CurrentStaff, Requires, type Staff } from '../http/staff.guard';
import { FRONT_DESK, PATIENTS } from '../http/tokens';
import { ZodPipe } from '../http/zod.pipe';

const isUuid = (s: string) => z.uuid().safeParse(s).success;

@ApiTags('calls')
@ApiCookieAuth()
@ApiParam({ name: 'clinicId', example: 'clinic_maple' })
@Controller('clinics/:clinicId/calls')
export class CallsController {
  constructor(@Inject(FRONT_DESK) private readonly desk: FrontDeskRepository, @Inject(PATIENTS) private readonly patients: PatientRecords) {}

  @Get()
  @Requires('calls:list')
  @ApiOperation({ summary: 'Calls, newest first, with optional filters. The verified patient\'s name is included for roles that may read calls, and that view is audited; a viewer gets no patient data.' })
  @ApiOkResponse({ schema: schemaOf(CallList) })
  async list(@Param('clinicId') clinicId: string, @Query(new ZodPipe(CallQuery)) q: z.infer<typeof CallQuery>, @CurrentStaff() staff: Staff): Promise<CallList> {
    const calls = await this.desk.listCalls(clinicId, {
      before: q.before, limit: q.limit, outcome: q.outcome, channel: q.channel, emergency: q.emergency, ...(await this.range(clinicId, q)), names: this.names(staff, 'list'),
    });
    return this.page(calls, q.limit);
  }

  @Post('search')
  @HttpCode(200)
  @Requires('calls:read')
  @ApiOperation({ summary: 'Calls with a verified patient whose name matches, with the same filters. Audited with the number of matches, never the name typed.' })
  @ApiBody({ schema: schemaOf(CallSearch) })
  @ApiOkResponse({ schema: schemaOf(CallList) })
  async search(@Param('clinicId') clinicId: string, @Body(new ZodPipe(CallSearch)) body: z.infer<typeof CallSearch>, @CurrentStaff() staff: Staff): Promise<CallList> {
    const patientIds = await this.patients.idsMatching(clinicId, body.query);
    const calls = await this.desk.listCalls(clinicId, {
      limit: 100, outcome: body.outcome, channel: body.channel, emergency: body.emergency, patientIds, ...(await this.range(clinicId, body)), names: this.names(staff, 'search'),
    });
    return this.page(calls, Number.POSITIVE_INFINITY);
  }

  private names(staff: Staff, audit: 'list' | 'search') {
    return staff.role && can(staff.role, 'calls:read') ? { userId: staff.userId, audit } : undefined;
  }

  /** Days in clinic time: from the start of `from` to the end of `to`. */
  private async range(clinicId: string, q: { from?: string; to?: string }): Promise<{ from?: Date; to?: Date }> {
    if (!q.from && !q.to) return {};
    const stored = await this.desk.settings(clinicId);
    if (!stored) throw new NotFoundException({ error: 'not_found' });
    const tz = ClinicConfig.parse(stored).timezone;
    return { from: q.from ? zonedInstant(q.from, '00:00', tz) : undefined, to: q.to ? zonedInstant(addDays(q.to, 1), '00:00', tz) : undefined };
  }

  private page(calls: Awaited<ReturnType<FrontDeskRepository['listCalls']>>, limit: number): CallList {
    const last = calls.at(-1);
    return {
      calls: calls.map((c) => ({
        id: c.id, channel: c.channel, outcome: c.outcome, emergency: c.emergency, closeReason: c.closeReason, voiceSeconds: c.voiceSeconds, tools: c.tools, verified: c.verified,
        patientName: c.patientName, startedAt: c.startedAt.toISOString(), endedAt: c.endedAt?.toISOString() ?? null,
      })),
      next: calls.length === limit && last ? callCursor.encode(last) : null,
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
