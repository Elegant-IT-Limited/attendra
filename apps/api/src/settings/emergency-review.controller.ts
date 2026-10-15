// SPDX-License-Identifier: AGPL-3.0-only
import { ClinicConfig, emergencyReviewSheet } from '@attendra/core';
import type { FrontDeskRepository } from '@attendra/db';
import { Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { EmergencyReview, EmergencyReviewInput } from '../contracts';
import { schemaOf } from '../http/openapi';
import { CurrentStaff, Requires, type Staff } from '../http/staff.guard';
import { CLOCK, FRONT_DESK } from '../http/tokens';
import { ZodPipe } from '../http/zod.pipe';

/**
 * The clinic's own review of the emergency lists: a veterinarian (or a clinician) reads
 * what the assistant treats as an emergency and the words callers hear, and records that
 * they reviewed it. A release that changes the lists makes the review out of date.
 */
@ApiTags('settings')
@ApiCookieAuth()
@ApiParam({ name: 'clinicId', example: 'clinic_maple' })
@Controller('clinics/:clinicId/emergency-review')
export class EmergencyReviewController {
  constructor(@Inject(FRONT_DESK) private readonly desk: FrontDeskRepository, @Inject(CLOCK) private readonly now: () => Date) {}

  private async clinic(clinicId: string) {
    const stored = await this.desk.settings(clinicId);
    if (!stored) throw new NotFoundException({ error: 'not_found' });
    return ClinicConfig.parse(stored);
  }

  private view(c: ClinicConfig): EmergencyReview {
    const sheet = emergencyReviewSheet(c);
    return { sheet, review: c.emergencyReview ?? null, current: c.emergencyReview?.version === sheet.version };
  }

  @Get()
  @Requires('settings:read')
  @ApiOperation({ summary: 'What the assistant treats as an emergency, the words callers hear, and the clinic\'s review of them' })
  @ApiOkResponse({ schema: schemaOf(EmergencyReview) })
  async get(@Param('clinicId') clinicId: string): Promise<EmergencyReview> {
    return this.view(await this.clinic(clinicId));
  }

  @Post()
  @HttpCode(200)
  @Requires('settings:write')
  @ApiOperation({ summary: 'Record that the clinic\'s veterinarian or clinician reviewed the emergency lists. Audited.' })
  @ApiBody({ schema: schemaOf(EmergencyReviewInput) })
  @ApiOkResponse({ schema: schemaOf(EmergencyReview) })
  async review(@Param('clinicId') clinicId: string, @Body(new ZodPipe(EmergencyReviewInput)) body: z.infer<typeof EmergencyReviewInput>, @CurrentStaff() staff: Staff): Promise<EmergencyReview> {
    const c = await this.clinic(clinicId);
    const next = ClinicConfig.parse({ ...c, emergencyReview: { ...body, reviewedAt: this.now().toISOString(), version: emergencyReviewSheet(c).version } });
    await this.desk.saveSettings(clinicId, next, staff.userId, 'clinic.emergency_list.reviewed');
    return this.view(next);
  }
}
