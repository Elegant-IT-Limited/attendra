// SPDX-License-Identifier: AGPL-3.0-only
import type { PatientCard as Card, PatientRecords, SaveResult } from '@attendra/db';
import { ClinicConfig, localDateOf } from '@attendra/core';
import { type FrontDeskRepository, staffNames, type Database } from '@attendra/db';
import { Body, ConflictException, Controller, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, UnprocessableEntityException } from '@nestjs/common';
import { ApiBody, ApiConflictResponse, ApiCookieAuth, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { type PatientCard, PatientInput, PatientList, PatientProfile, PatientSaved, PatientSearch } from '../contracts';
import { schemaOf } from '../http/openapi';
import { CurrentStaff, Requires, type Staff } from '../http/staff.guard';
import { CLOCK, DB, FRONT_DESK, PATIENTS } from '../http/tokens';
import { ZodPipe } from '../http/zod.pipe';

const isUuid = (s: string) => z.uuid().safeParse(s).success;
const toCard = (p: Card): PatientCard => ({ ...p, name: `${p.firstName} ${p.lastName}` });

@ApiTags('patients')
@ApiCookieAuth()
@ApiParam({ name: 'clinicId', example: 'clinic_maple' })
@Controller('clinics/:clinicId/patients')
export class PatientsController {
  constructor(
    @Inject(PATIENTS) private readonly records: PatientRecords,
    @Inject(DB) private readonly db: Database,
    @Inject(CLOCK) private readonly now: () => Date,
    @Inject(FRONT_DESK) private readonly desk: FrontDeskRepository,
  ) {}

  /** A date of birth cannot be after today where the clinic is, whatever the server's own date. */
  private async checkDob(clinicId: string, dob: string) {
    const stored = await this.desk.settings(clinicId);
    if (!stored) throw new NotFoundException({ error: 'not_found' });
    if (dob > localDateOf(this.now(), ClinicConfig.parse(stored).timezone)) {
      throw new UnprocessableEntityException({ error: 'invalid_request', issues: [{ path: 'dob', message: 'a date of birth cannot be in the future' }] });
    }
  }

  /** A POST, not a GET: what is typed can be a name or a date of birth, and URLs end up in logs. */
  @Post('search')
  @HttpCode(200)
  @Requires('patients:read')
  @ApiOperation({ summary: 'Find patients by name, date of birth or full phone number. At most 25. Audited with the number of matches, not the query.' })
  @ApiBody({ schema: schemaOf(PatientSearch) })
  @ApiOkResponse({ schema: schemaOf(PatientList) })
  async search(@Param('clinicId') clinicId: string, @Body(new ZodPipe(PatientSearch)) body: z.infer<typeof PatientSearch>, @CurrentStaff() staff: Staff): Promise<PatientList> {
    const found = await this.records.search(clinicId, body.query, staff.userId, this.now());
    if (!found) throw new UnprocessableEntityException({ error: 'invalid_request', issues: [{ path: 'query', message: 'type a name, a date of birth or a full phone number' }] });
    return { patients: found.patients.map(toCard), truncated: found.truncated };
  }

  @Get('recent')
  @Requires('patients:read')
  @ApiOperation({ summary: 'The last 10 patients you opened, newest first' })
  @ApiOkResponse({ schema: schemaOf(PatientList) })
  async recent(@Param('clinicId') clinicId: string, @CurrentStaff() staff: Staff): Promise<PatientList> {
    return { patients: (await this.records.recent(clinicId, staff.userId)).map(toCard) };
  }

  @Get(':patientId')
  @Requires('patients:read')
  @ApiOperation({ summary: 'A patient with their appointments, verified calls and requests. Audited as a PHI view.' })
  @ApiOkResponse({ schema: schemaOf(PatientProfile) })
  @ApiNotFoundResponse()
  async get(@Param('clinicId') clinicId: string, @Param('patientId') id: string, @CurrentStaff() staff: Staff): Promise<PatientProfile> {
    const p = isUuid(id) ? await this.records.profile(clinicId, id, staff.userId) : null;
    if (!p) throw new NotFoundException({ error: 'not_found' });
    const names = await staffNames(this.db, clinicId, p.appointments.flatMap((a) => (a.createdByUserId ? [a.createdByUserId] : [])));
    const seen = new Map<string, number>();
    for (const a of p.appointments) if (a.status === 'booked' && a.startsAt < this.now()) seen.set(a.providerId, (seen.get(a.providerId) ?? 0) + 1);
    const usual = [...seen.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const now = this.now().getTime();
    return {
      ...toCard(p),
      createdAt: p.createdAt.toISOString(),
      usualProviderId: usual,
      // what is coming first, soonest first; then what has been, latest first
      appointments: [...p.appointments.filter((a) => a.startsAt.getTime() >= now).reverse(), ...p.appointments.filter((a) => a.startsAt.getTime() < now)].map((a) => ({
        id: a.id, providerId: a.providerId, visitTypeId: a.visitTypeId, startsAt: a.startsAt.toISOString(), endsAt: a.endsAt.toISOString(), status: a.status,
        bookedBy: a.createdByCallId ? { kind: 'assistant' as const, callId: a.createdByCallId } : { kind: 'staff' as const, name: names.get(a.createdByUserId ?? '') ?? null },
      })),
      calls: p.calls.map((c) => ({ ...c, startedAt: c.startedAt.toISOString() })),
      requests: p.requests.map((t) => ({ ...t, createdAt: t.createdAt.toISOString(), doneAt: t.doneAt?.toISOString() ?? null })),
    };
  }

  @Post()
  @HttpCode(200)
  @Requires('patients:write')
  @ApiOperation({ summary: 'Add a patient. The assistant can verify them on their next call. Audited.' })
  @ApiBody({ schema: schemaOf(PatientInput) })
  @ApiOkResponse({ schema: schemaOf(PatientSaved) })
  @ApiConflictResponse({ description: 'Someone with this name and date of birth is already on file; `id` is theirs' })
  async create(@Param('clinicId') clinicId: string, @Body(new ZodPipe(PatientInput)) body: z.infer<typeof PatientInput>, @CurrentStaff() staff: Staff): Promise<PatientSaved> {
    await this.checkDob(clinicId, body.dob);
    return this.answer(await this.records.create(clinicId, body, staff.userId));
  }

  @Patch(':patientId')
  @Requires('patients:write')
  @ApiOperation({ summary: 'Change a patient\'s name, date of birth or phone. Audited.' })
  @ApiBody({ schema: schemaOf(PatientInput) })
  @ApiOkResponse({ schema: schemaOf(PatientSaved) })
  @ApiConflictResponse({ description: 'The change would make them the same as someone already on file' })
  async update(@Param('clinicId') clinicId: string, @Param('patientId') id: string, @Body(new ZodPipe(PatientInput)) body: z.infer<typeof PatientInput>, @CurrentStaff() staff: Staff): Promise<PatientSaved> {
    if (!isUuid(id)) throw new NotFoundException({ error: 'not_found' });
    await this.checkDob(clinicId, body.dob);
    return this.answer(await this.records.update(clinicId, id, body, staff.userId));
  }

  private answer(r: SaveResult): PatientSaved {
    if (r.status === 'not_found') throw new NotFoundException({ error: 'not_found' });
    if (r.status === 'exists') throw new ConflictException({ error: 'patient_exists', id: r.id, message: 'Someone with this name and date of birth is already on file.' });
    return { id: r.id };
  }
}
