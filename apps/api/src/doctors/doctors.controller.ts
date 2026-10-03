// SPDX-License-Identifier: AGPL-3.0-only
import { ClinicConfig, configProblems, newProviderId, type Provider, readDoctors } from '@attendra/core';
import type { FrontDeskRepository, Tx } from '@attendra/db';
import { Body, ConflictException, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Post, Put, UnprocessableEntityException } from '@nestjs/common';
import { ApiBody, ApiConflictResponse, ApiCookieAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags, ApiUnprocessableEntityResponse } from '@nestjs/swagger';
import type { z } from 'zod';
import { DoctorInput, DoctorList, ImportInput, ImportResult } from '../contracts';
import { schemaOf } from '../http/openapi';
import { CurrentStaff, Requires, type Staff } from '../http/staff.guard';
import { CLOCK, FRONT_DESK } from '../http/tokens';
import { issuesOf, ZodPipe } from '../http/zod.pipe';

type Issues = ReturnType<typeof issuesOf>;
type Change = { config: ClinicConfig } | { error: string; status: 404 | 409 } | { issues: Issues };

/**
 * The clinic's doctors, and rooms booked like one: who they are, what they see people
 * for, the ages they see, their weekly hours and their days off. They live in the
 * clinic's settings, which the voice service reads again before every request on a
 * call, so the assistant knows a change from the next thing a caller asks.
 */
@ApiTags('doctors')
@ApiCookieAuth()
@ApiParam({ name: 'clinicId', example: 'clinic_maple' })
@Controller('clinics/:clinicId/doctors')
export class DoctorsController {
  constructor(@Inject(FRONT_DESK) private readonly desk: FrontDeskRepository, @Inject(CLOCK) private readonly now: () => Date) {}

  @Get()
  @Requires('settings:read')
  @ApiOperation({ summary: 'The doctors and the visit types they can be booked for' })
  @ApiOkResponse({ schema: schemaOf(DoctorList) })
  async list(@Param('clinicId') clinicId: string): Promise<DoctorList> {
    const stored = await this.desk.settings(clinicId);
    if (!stored) throw new NotFoundException({ error: 'not_found' });
    const c = ClinicConfig.parse(stored);
    return { providers: c.providers, visitTypes: c.visitTypes };
  }

  @Post()
  @HttpCode(201)
  @Requires('settings:write')
  @ApiOperation({ summary: 'Add a doctor. Audited. The assistant knows them from the next request on any call.' })
  @ApiBody({ schema: schemaOf(DoctorInput) })
  @ApiOkResponse({ schema: schemaOf(DoctorList) })
  async add(@Param('clinicId') clinicId: string, @Body(new ZodPipe(DoctorInput)) body: z.infer<typeof DoctorInput>, @CurrentStaff() staff: Staff): Promise<DoctorList> {
    const id = body.id ?? newProviderId(body.name);
    return this.change(clinicId, staff, 'clinic.doctor.added', id, (c) => {
      if (c.providers.some((p) => p.id === id)) return { error: `a doctor with the id ${id} is already on file`, status: 409 };
      return { config: { ...c, providers: [...c.providers, { ...body, id } as Provider] } };
    });
  }

  @Put(':providerId')
  @Requires('settings:write')
  @ApiOperation({ summary: 'Change a doctor: details, hours, days off. Audited.' })
  @ApiBody({ schema: schemaOf(DoctorInput) })
  @ApiOkResponse({ schema: schemaOf(DoctorList) })
  async update(@Param('clinicId') clinicId: string, @Param('providerId') providerId: string, @Body(new ZodPipe(DoctorInput)) body: z.infer<typeof DoctorInput>, @CurrentStaff() staff: Staff): Promise<DoctorList> {
    return this.change(clinicId, staff, 'clinic.doctor.updated', providerId, (c) => {
      if (!c.providers.some((p) => p.id === providerId)) return { error: 'not_found', status: 404 };
      return { config: { ...c, providers: c.providers.map((p) => (p.id === providerId ? { ...body, id: providerId } as Provider : p)) } };
    });
  }

  @Delete(':providerId')
  @Requires('settings:write')
  @ApiOperation({ summary: 'Remove a doctor with no visits still to come. Audited.' })
  @ApiOkResponse({ schema: schemaOf(DoctorList) })
  @ApiConflictResponse({ description: 'They still have booked visits to come, or they are the last doctor' })
  async remove(@Param('clinicId') clinicId: string, @Param('providerId') providerId: string, @CurrentStaff() staff: Staff): Promise<DoctorList> {
    // counted with the settings row locked, so a booking made a moment before is seen
    return this.change(clinicId, staff, 'clinic.doctor.removed', providerId, async (c, tx) => {
      if (!c.providers.some((p) => p.id === providerId)) return { error: 'not_found', status: 404 };
      const upcoming = await this.desk.upcomingForProvider(clinicId, providerId, this.now(), tx);
      if (upcoming) return { error: `They have ${upcoming} booked ${upcoming === 1 ? 'visit' : 'visits'} still to come. Move or cancel ${upcoming === 1 ? 'it' : 'them'} on the Schedule first.`, status: 409 };
      if (c.providers.length === 1) return { error: 'A clinic needs at least one doctor for the assistant to book with.', status: 409 };
      return { config: { ...c, providers: c.providers.filter((p) => p.id !== providerId) } };
    });
  }

  /**
   * A CSV of doctors. With `dryRun` every row is checked and nothing changes; without
   * it the valid rows are saved together, in one change to the settings, and rows with
   * a problem are left out and listed.
   */
  @Post('import')
  @HttpCode(200)
  @Requires('settings:write')
  @ApiOperation({ summary: 'Add or update doctors from a CSV file (the template on the Doctors page). Audited once per import.' })
  @ApiBody({ schema: schemaOf(ImportInput) })
  @ApiOkResponse({ schema: schemaOf(ImportResult) })
  @ApiUnprocessableEntityResponse({ description: 'The result would not be a valid configuration' })
  async import(@Param('clinicId') clinicId: string, @Body(new ZodPipe(ImportInput)) body: z.infer<typeof ImportInput>, @CurrentStaff() staff: Staff): Promise<ImportResult> {
    const out = await this.desk.updateSettings<{ report: ImportResult } | { issues: Issues }>(clinicId, staff.userId, 'clinic.doctors.imported', clinicId, (stored) => {
      const c = ClinicConfig.parse(stored);
      const rows = readDoctors(body.csv, c);
      const report: ImportResult = {
        dryRun: body.dryRun,
        rows: rows.map((r) => ({ line: r.line, name: r.name, status: r.ok ? (r.existingId ? 'update' : 'add') : 'error', message: r.ok ? null : r.message })),
        counts: { add: 0, update: 0, skip: 0, error: 0 },
      };
      for (const r of report.rows) report.counts[r.status]++;
      const good = rows.flatMap((r) => (r.ok ? [r] : []));
      if (body.dryRun || !good.length) return { result: { report } };
      const providers = c.providers.map((p) => good.find((r) => r.existingId === p.id)?.value ?? p).concat(good.filter((r) => !r.existingId).map((r) => r.value));
      const parsed = ClinicConfig.safeParse({ ...c, providers });
      if (!parsed.success) return { result: { issues: issuesOf(parsed.error) } };
      if (configProblems(parsed.data).length) return { result: { issues: configProblems(parsed.data) } };
      return { save: parsed.data, result: { report } };
    });
    if (!out) throw new NotFoundException({ error: 'not_found' });
    if ('issues' in out) throw new UnprocessableEntityException({ error: 'invalid_settings', issues: out.issues });
    return out.report;
  }

  private async change(clinicId: string, staff: Staff, action: string, entityId: string, fn: (c: ClinicConfig, tx: Tx) => Change | Promise<Change>): Promise<DoctorList> {
    const out = await this.desk.updateSettings<Change>(clinicId, staff.userId, action, entityId, async (stored, tx) => {
      const next = await fn(ClinicConfig.parse(stored), tx);
      if (!('config' in next)) return { result: next };
      // the same checks as saving Settings: ids unique, visit types that exist, hours that make sense
      const parsed = ClinicConfig.safeParse(next.config);
      if (!parsed.success) return { result: { issues: issuesOf(parsed.error) } };
      if (configProblems(parsed.data).length) return { result: { issues: configProblems(parsed.data) } };
      return { save: parsed.data, result: { config: parsed.data } };
    });
    if (!out) throw new NotFoundException({ error: 'not_found' });
    if ('issues' in out) throw new UnprocessableEntityException({ error: 'invalid_doctor', issues: out.issues });
    if ('error' in out) {
      if (out.status === 404) throw new NotFoundException({ error: 'not_found' });
      throw new ConflictException({ error: out.error.startsWith('They have') ? 'has_upcoming_visits' : 'conflict', message: out.error });
    }
    return { providers: out.config.providers, visitTypes: out.config.visitTypes };
  }
}
