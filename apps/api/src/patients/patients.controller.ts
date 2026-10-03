// SPDX-License-Identifier: AGPL-3.0-only
import type { PatientCard as Card, PatientRecords, SaveResult } from '@attendra/db';
import { ageOn, ClinicConfig, localDateOf, readPatients } from '@attendra/core';
import { type FrontDeskRepository, staffNames, type Database, withClinic } from '@attendra/db';
import { Body, ConflictException, Controller, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Query, UnprocessableEntityException } from '@nestjs/common';
import { ApiBody, ApiConflictResponse, ApiCookieAuth, ApiCreatedResponse, ApiNoContentResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ImportInput, ImportResult, type PatientCard, PatientInput, PatientList, PatientListQuery, PatientProfile, PatientSaved, PatientSearch } from '../contracts';
import { schemaOf } from '../http/openapi';
import { CurrentStaff, Requires, type Staff } from '../http/staff.guard';
import { CLOCK, DB, FRONT_DESK, PATIENTS } from '../http/tokens';
import { ZodPipe } from '../http/zod.pipe';

const isUuid = (s: string) => z.uuid().safeParse(s).success;
const toCard = (p: Card): PatientCard => ({ ...p, name: `${p.firstName} ${p.lastName}`, createdAt: p.createdAt.toISOString() });

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

  private async clinic(clinicId: string) {
    const stored = await this.desk.settings(clinicId);
    if (!stored) throw new NotFoundException({ error: 'not_found' });
    return ClinicConfig.parse(stored);
  }

  /**
   * A date of birth cannot be after today where the clinic is, whatever the server's own
   * date, and a patient under 18 has a parent or guardian on file.
   */
  private async check(clinicId: string, body: z.infer<typeof PatientInput>) {
    const today = localDateOf(this.now(), (await this.clinic(clinicId)).timezone);
    if (body.dob > today) {
      throw new UnprocessableEntityException({ error: 'invalid_request', issues: [{ path: 'dob', message: 'a date of birth cannot be in the future' }] });
    }
    if (ageOn(body.dob, today) < 18 && !body.guardianName?.trim()) {
      throw new UnprocessableEntityException({ error: 'invalid_request', issues: [{ path: 'guardianName', message: 'a patient under 18 needs a parent or guardian' }] });
    }
  }

  @Get()
  @Requires('patients:read')
  @ApiOperation({ summary: 'The newest patients first, before anything is typed. status=new lists the ones the assistant added that nobody has checked. Audited.' })
  @ApiOkResponse({ schema: schemaOf(PatientList) })
  async newest(@Param('clinicId') clinicId: string, @Query(new ZodPipe(PatientListQuery)) q: z.infer<typeof PatientListQuery>, @CurrentStaff() staff: Staff): Promise<PatientList> {
    return { patients: (await this.records.newest(clinicId, staff.userId, { status: q.status })).map(toCard) };
  }

  /** A POST, not a GET: what is typed can be a name or a date of birth, and URLs end up in logs. */
  @Post('search')
  @HttpCode(200)
  @Requires('patients:read')
  @ApiOperation({ summary: 'Find patients as you type: the start of a name, any digits of a phone number, or a date of birth. At most 25. Audited with the number of matches, not the query.' })
  @ApiBody({ schema: schemaOf(PatientSearch) })
  @ApiOkResponse({ schema: schemaOf(PatientList) })
  async search(@Param('clinicId') clinicId: string, @Body(new ZodPipe(PatientSearch)) body: z.infer<typeof PatientSearch>, @CurrentStaff() staff: Staff): Promise<PatientList> {
    const found = await this.records.search(clinicId, body.query, staff.userId, this.now(), { status: body.status });
    if (!found) return { patients: [], truncated: false };
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
      createdByCallId: p.createdByCallId,
      household: p.household.map(toCard),
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
  @HttpCode(201)
  @Requires('patients:write')
  @ApiOperation({ summary: 'Add a patient. The assistant can verify them on their next call. Audited.' })
  @ApiBody({ schema: schemaOf(PatientInput) })
  @ApiCreatedResponse({ schema: schemaOf(PatientSaved) })
  @ApiConflictResponse({ description: 'The same person (name, date of birth and phone) is already on file; `id` is theirs' })
  async create(@Param('clinicId') clinicId: string, @Body(new ZodPipe(PatientInput)) body: z.infer<typeof PatientInput>, @CurrentStaff() staff: Staff): Promise<PatientSaved> {
    await this.check(clinicId, body);
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
    await this.check(clinicId, body);
    return this.answer(await this.records.update(clinicId, id, body, staff.userId));
  }

  @Post(':patientId/confirm')
  @HttpCode(204)
  @Requires('patients:write')
  @ApiOperation({ summary: 'The details of a patient the assistant added are checked: they become an ordinary patient, and the request to check them is closed. Audited.' })
  @ApiNoContentResponse()
  async confirm(@Param('clinicId') clinicId: string, @Param('patientId') id: string, @CurrentStaff() staff: Staff): Promise<void> {
    if (!isUuid(id) || (await this.records.confirm(clinicId, id, staff.userId)) === 'not_found') throw new NotFoundException({ error: 'not_found' });
  }

  /**
   * A CSV of patients (the template on the Patients page). With `dryRun` every row is
   * checked and nothing changes. Without it the new patients are added in one
   * transaction; someone already on file with the same name, date of birth and phone
   * is skipped, so the same file can be uploaded twice.
   */
  @Post('import')
  @HttpCode(200)
  @Requires('patients:import')
  @ApiOperation({ summary: 'Add patients from a CSV file. Managers only. Audited per patient added.' })
  @ApiBody({ schema: schemaOf(ImportInput) })
  @ApiOkResponse({ schema: schemaOf(ImportResult) })
  async import(@Param('clinicId') clinicId: string, @Body(new ZodPipe(ImportInput)) body: z.infer<typeof ImportInput>, @CurrentStaff() staff: Staff): Promise<ImportResult> {
    const clinic = await this.clinic(clinicId);
    const rows = readPatients(body.csv, localDateOf(this.now(), clinic.timezone), clinic.phoneNumbers[0]!.startsWith('+1'));
    const report: ImportResult = { dryRun: body.dryRun, rows: [], counts: { add: 0, update: 0, skip: 0, error: 0 } };
    // one transaction: a dry run rolls it back, so it checks against the database exactly as the import would
    const dryRun = Symbol('dry run');
    await withClinic(this.db, clinicId, async (tx) => {
      for (const r of rows) {
        if (!r.ok) { report.rows.push({ line: r.line, name: r.name, status: 'error', message: r.message }); continue; }
        const saved = await this.records.insert(tx, clinicId, r.value, `user:${staff.userId}`);
        if (saved.status === 'exists') report.rows.push({ line: r.line, name: r.name, status: 'skip', message: 'already on file with this name, date of birth and phone' });
        else report.rows.push({ line: r.line, name: r.name, status: 'add', message: saved.status === 'saved' && saved.similar ? 'someone else has this name and date of birth, on another phone' : null });
      }
      if (body.dryRun) throw dryRun;
    }).catch((err: unknown) => { if (err !== dryRun) throw err; });
    for (const r of report.rows) report.counts[r.status]++;
    return report;
  }

  private answer(r: SaveResult): PatientSaved {
    if (r.status === 'not_found') throw new NotFoundException({ error: 'not_found' });
    if (r.status === 'exists') throw new ConflictException({ error: 'patient_exists', id: r.id, message: 'This patient is already on file: the same name, date of birth and phone number.' });
    return { id: r.id, similar: r.similar };
  }
}
