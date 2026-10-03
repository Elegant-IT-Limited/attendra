// SPDX-License-Identifier: AGPL-3.0-only
import { ClinicConfig, emergencyNumberProblem } from '@attendra/core';
import type { FrontDeskRepository } from '@attendra/db';
import { Body, Controller, Get, Inject, NotFoundException, Param, Put, UnprocessableEntityException } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags, ApiUnprocessableEntityResponse } from '@nestjs/swagger';
import { schemaOf } from '../http/openapi';
import { CurrentStaff, Requires, type Staff } from '../http/staff.guard';
import { API_OPTIONS, type ApiOptions, FRONT_DESK } from '../http/tokens';
import { issuesOf } from '../http/zod.pipe';

@ApiTags('settings')
@ApiCookieAuth()
@ApiParam({ name: 'clinicId', example: 'clinic_maple' })
@Controller('clinics/:clinicId/settings')
export class SettingsController {
  constructor(@Inject(FRONT_DESK) private readonly desk: FrontDeskRepository, @Inject(API_OPTIONS) private readonly options: ApiOptions) {}

  @Get()
  @Requires('settings:read')
  @ApiOperation({ summary: 'The clinic configuration the voice agent runs with' })
  @ApiOkResponse({ schema: schemaOf(ClinicConfig) })
  async get(@Param('clinicId') clinicId: string): Promise<ClinicConfig> {
    const stored = await this.desk.settings(clinicId);
    if (!stored) throw new NotFoundException({ error: 'not_found' });
    return ClinicConfig.parse(stored);
  }

  /**
   * Saves the whole configuration. The same schema the voice service checks at call
   * time runs here, so a manager cannot save a greeting without the AI disclosure or
   * turn on recording without a notice. Phone numbers are provisioned by the
   * operator and cannot be changed from the dashboard.
   */
  @Put()
  @Requires('settings:write')
  @ApiOperation({ summary: 'Replace the clinic configuration. Audited.' })
  @ApiBody({ schema: schemaOf(ClinicConfig) })
  @ApiOkResponse({ schema: schemaOf(ClinicConfig) })
  @ApiUnprocessableEntityResponse({ description: 'The configuration failed validation' })
  async put(@Param('clinicId') clinicId: string, @Body() body: unknown, @CurrentStaff() staff: Staff): Promise<ClinicConfig> {
    const parsed = ClinicConfig.safeParse(body);
    if (!parsed.success) throw new UnprocessableEntityException({ error: 'invalid_settings', issues: issuesOf(parsed.error) });
    const current = ClinicConfig.parse(await this.desk.settings(clinicId));
    // Doctors are changed on the Doctors page. Settings keeps the ones on file, so a
    // Settings page opened before a doctor was added cannot remove them; a visit type
    // removed here is taken off every doctor who offered it.
    const providers = current.providers.map((p) => ({ ...p, visitTypeIds: p.visitTypeIds.filter((id) => parsed.data.visitTypes.some((v) => v.id === id)) }));
    const stranded = providers.find((p) => !p.visitTypeIds.length);
    if (stranded) {
      throw new UnprocessableEntityException({ error: 'invalid_settings', issues: [{ path: 'visitTypes', message: `${stranded.name} would have no visit types left. Give them another one on the Doctors page first.` }] });
    }
    const merged = ClinicConfig.safeParse({ ...parsed.data, providers });
    if (!merged.success) throw new UnprocessableEntityException({ error: 'invalid_settings', issues: issuesOf(merged.error) });
    const next = merged.data;
    if (next.id !== clinicId) throw new UnprocessableEntityException({ error: 'invalid_settings', issues: [{ path: 'id', message: 'the clinic id cannot change' }] });
    // in order: the first number is the one confirmations are texted from
    if (JSON.stringify(next.phoneNumbers) !== JSON.stringify(current.phoneNumbers)) {
      throw new UnprocessableEntityException({ error: 'invalid_settings', issues: [{ path: 'phoneNumbers', message: 'phone numbers are managed by your Attendra operator' }] });
    }
    // checked here, not in the schema: a number saved before the rule must not stop calls, and the voice service falls back to the country's
    const emergency = emergencyNumberProblem(next);
    if (emergency) throw new UnprocessableEntityException({ error: 'invalid_settings', issues: [{ path: 'emergencyNumber', message: emergency }] });
    // A demo deployment can take real calls, so nobody signed in to it may send them somewhere new.
    if (this.options.demoMode && JSON.stringify(next.routing) !== JSON.stringify(current.routing)) {
      throw new UnprocessableEntityException({ error: 'invalid_settings', issues: [{ path: 'routing', message: 'transfer numbers cannot be changed in demo mode' }] });
    }
    await this.desk.saveSettings(clinicId, next, staff.userId);
    return next;
  }
}
