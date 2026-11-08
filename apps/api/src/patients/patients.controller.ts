// SPDX-License-Identifier: AGPL-3.0-only
import type { PatientCard as Card, PatientRecords, SaveResult } from '@attendra/db';
import { ageOn, asE164, ClinicConfig, type EventSink, industryPack, leftOffList, listRowNote, localDateOf, managedList, notOnListProblem, onList, readCustomValues, readPatients, readPets, usualProviderOf, withListValues } from '@attendra/core';
import { type FrontDeskRepository, type MergeProblem, type PhiCipher, PatientRemoval, PostgresPatientDirectory, staffNames, type Database, withClinic } from '@attendra/db';
import { Body, ConflictException, Controller, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Put, Query, UnprocessableEntityException } from '@nestjs/common';
import { ApiBody, ApiConflictResponse, ApiCookieAuth, ApiCreatedResponse, ApiNoContentResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CustomFieldValues, Household, HouseholdQuery, PatientDelete, PatientDeleteCounts, PatientFilter, ImportInput, ImportResult, type PatientCard, PatientInput, PatientList, PatientListQuery, PatientMerge, PatientMergeCounts, PatientProfile, PatientSaved, PatientSearch } from '../contracts';
import { schemaOf } from '../http/openapi';
import { CurrentStaff, Requires, type Staff } from '../http/staff.guard';
import { CIPHER, CLOCK, DB, EVENTS, FRONT_DESK, PATIENTS } from '../http/tokens';
import { ZodPipe } from '../http/zod.pipe';

const isUuid = (s: string) => z.uuid().safeParse(s).success;
// a pet whose owner goes by one name has no family name: its name alone
const toCard = (p: Card): PatientCard => ({ ...p, name: `${p.firstName} ${p.lastName}`.trim(), createdAt: p.createdAt.toISOString() });

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
    @Inject(CIPHER) private readonly cipher: PhiCipher,
    @Inject(EVENTS) private readonly events: EventSink,
  ) {
    this.removal = new PatientRemoval(db, cipher);
  }

  private readonly removal: PatientRemoval;

  private async clinic(clinicId: string) {
    const stored = await this.desk.settings(clinicId);
    if (!stored) throw new NotFoundException({ error: 'not_found' });
    return ClinicConfig.parse(stored);
  }

  /**
   * A date of birth cannot be after today where the clinic is, whatever the server's own
   * date, and a patient under 18 has a parent or guardian on file. A pet's owner may go
   * by one name: a call finds the pet by that name, the pet's name and the phone.
   */
  private async check(clinicId: string, body: z.infer<typeof PatientInput>) {
    const clinic = await this.clinic(clinicId);
    const today = localDateOf(this.now(), clinic.timezone);
    const pet = industryPack(clinic.industry).identity === 'pet';
    if (body.dob > today) {
      throw new UnprocessableEntityException({ error: 'invalid_request', issues: [{ path: 'dob', message: pet ? 'A birthday can\'t be in the future.' : 'A date of birth can\'t be in the future.' }] });
    }
    // a pet is found on a call by its owner's name, so every pet has an owner; age does not matter
    if (pet) {
      if (!body.guardianName?.trim()) {
        throw new UnprocessableEntityException({ error: 'invalid_request', issues: [{ path: 'guardianName', message: 'Add the owner\'s first name.' }] });
      }
      // the kind of animal comes from the clinic's list; an edit that leaves it out keeps what the pet has
      const species = body.species ? notOnListProblem(clinic, 'species', [body.species]) : null;
      if (species) throw new UnprocessableEntityException({ error: 'invalid_request', issues: [{ path: 'species', message: species }] });
      return;
    }
    if (!body.lastName) throw new UnprocessableEntityException({ error: 'invalid_request', issues: [{ path: 'lastName', message: 'Add the last name.' }] });
    if (ageOn(body.dob, today) < 18 && !body.guardianName?.trim()) {
      throw new UnprocessableEntityException({ error: 'invalid_request', issues: [{ path: 'guardianName', message: 'a patient under 18 needs a parent or guardian' }] });
    }
  }

  @Get()
  @Requires('patients:read')
  @ApiOperation({ summary: 'The newest patients first, before anything is typed. status=new lists the ones the assistant added that nobody has checked. Audited.' })
  @ApiOkResponse({ schema: schemaOf(PatientList) })
  async newest(@Param('clinicId') clinicId: string, @Query(new ZodPipe(PatientListQuery)) q: z.infer<typeof PatientListQuery>, @CurrentStaff() staff: Staff): Promise<PatientList> {
    const fields = (await this.clinic(clinicId)).customFields ?? [];
    return { patients: (await this.records.newest(clinicId, staff.userId, { status: q.status })).map((p) => this.withFields(p, fields)) };
  }

  @Post('filter')
  @HttpCode(200)
  @Requires('patients:read')
  @ApiOperation({ summary: 'Patients of one kind of animal, or with one value in one of the clinic\'s own fields, newest first, at most 100. Audited like the list.' })
  @ApiBody({ schema: schemaOf(PatientFilter) })
  @ApiOkResponse({ schema: schemaOf(PatientList) })
  async filter(@Param('clinicId') clinicId: string, @Body(new ZodPipe(PatientFilter)) body: z.infer<typeof PatientFilter>, @CurrentStaff() staff: Staff): Promise<PatientList> {
    const fields = (await this.clinic(clinicId)).customFields ?? [];
    const field = body.field ? fields.find((f) => f.id === body.field!.id) : undefined;
    if (body.field && !field) throw new UnprocessableEntityException({ error: 'invalid_request', issues: [{ path: 'field.id', message: 'this clinic has no such field' }] });
    const found = await this.records.filtered(clinicId, staff.userId, { species: body.species, field: field && body.field ? { id: field.id, value: body.field.value, multi: field.kind === 'multi' } : undefined });
    return { patients: found.patients.map((p) => this.withFields(p, fields)), truncated: found.truncated };
  }

  /** A card shows only the fields the clinic still has. */
  private withFields(p: Card, fields: { id: string }[]): PatientCard {
    const ids = new Set(fields.map((f) => f.id));
    return toCard({ ...p, custom: Object.fromEntries(Object.entries(p.custom).filter(([id]) => ids.has(id))) });
  }

  /** A POST, not a GET: a phone number in a URL ends up in logs. The number is the household: the pet form fills the owner from it. */
  @Post('household')
  @HttpCode(200)
  @Requires('patients:read')
  @ApiOperation({ summary: 'Who owns a phone number and which pets are on it already, so a pet added under a known number joins its owner. Audited by how many were read.' })
  @ApiBody({ schema: schemaOf(HouseholdQuery) })
  @ApiOkResponse({ schema: schemaOf(Household) })
  async household(@Param('clinicId') clinicId: string, @Body(new ZodPipe(HouseholdQuery)) body: z.infer<typeof HouseholdQuery>, @CurrentStaff() staff: Staff): Promise<Household> {
    const clinic = await this.clinic(clinicId);
    return new PostgresPatientDirectory(this.db, this.cipher, `user:${staff.userId}`).household(clinicId, asE164(clinic, body.phone));
  }

  /** A POST, not a GET: what is typed can be a name or a date of birth, and URLs end up in logs. */
  @Post('search')
  @HttpCode(200)
  @Requires('patients:read')
  @ApiOperation({ summary: 'Find patients as you type: the start of a name (the record\'s own or the owner\'s, any order, or as it sounds), a phone number in any form or its last digits, a date of birth, or a request number ("R-1042"). At most 25, each saying what it matched on. Audited with the number of matches, not the query.' })
  @ApiBody({ schema: schemaOf(PatientSearch) })
  @ApiOkResponse({ schema: schemaOf(PatientList) })
  async search(@Param('clinicId') clinicId: string, @Body(new ZodPipe(PatientSearch)) body: z.infer<typeof PatientSearch>, @CurrentStaff() staff: Staff): Promise<PatientList> {
    const found = await this.records.search(clinicId, body.query, staff.userId, this.now(), { status: body.status });
    if (!found) return { patients: [], truncated: false };
    const fields = (await this.clinic(clinicId)).customFields ?? [];
    return { patients: found.patients.map((p) => this.withFields(p, fields)), truncated: found.truncated };
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
    // the same rule the assistant books by: most visits in two years, the latest breaking a tie
    const usual = usualProviderOf(p.appointments.map((a) => ({ providerId: a.providerId, start: a.startsAt, status: a.status })), this.now());
    const now = this.now().getTime();
    const fields = new Set((await this.clinic(clinicId)).customFields?.map((f) => f.id) ?? []);
    return {
      ...toCard(p),
      createdByCallId: p.createdByCallId,
      customFields: Object.fromEntries(Object.entries(p.customFields).filter(([id]) => fields.has(id))),
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
    return this.answer(await this.records.create(clinicId, { ...body, phone: asE164(await this.clinic(clinicId), body.phone) }, staff.userId));
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
    return this.answer(await this.records.update(clinicId, id, { ...body, phone: asE164(await this.clinic(clinicId), body.phone) }, staff.userId));
  }

  @Put(':patientId/fields')
  @HttpCode(204)
  @Requires('patients:write')
  @ApiOperation({ summary: 'Set the clinic\'s own details on a record (the fields in its settings), the whole set at once. Audited without the values.' })
  @ApiBody({ schema: schemaOf(CustomFieldValues) })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async fields(@Param('clinicId') clinicId: string, @Param('patientId') id: string, @Body(new ZodPipe(CustomFieldValues)) body: z.infer<typeof CustomFieldValues>, @CurrentStaff() staff: Staff): Promise<void> {
    if (!isUuid(id)) throw new NotFoundException({ error: 'not_found' });
    const read = readCustomValues((await this.clinic(clinicId)).customFields ?? [], body.values, { complete: true });
    if (!read.ok) throw new UnprocessableEntityException({ error: 'invalid_request', issues: [{ path: `values.${read.field}`, message: read.message }] });
    if ((await this.records.setCustomFields(clinicId, id, read.values, staff.userId)) === 'not_found') throw new NotFoundException({ error: 'not_found' });
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
    // a vet clinic's file is one row per pet, with its owner
    const read = industryPack(clinic.industry).identity === 'pet' ? readPets : readPatients;
    const rows = read(body.csv, localDateOf(this.now(), clinic.timezone), clinic.phoneNumbers[0]!.startsWith('+1'), managedList(clinic, 'species'));
    const report: ImportResult = { dryRun: body.dryRun, rows: [], counts: { add: 0, update: 0, skip: 0, error: 0, notListed: 0 } };
    // one transaction: a dry run rolls it back, so it checks against the database exactly as the import would
    const dryRun = Symbol('dry run');
    const similar = new Set<number>();
    await withClinic(this.db, clinicId, async (tx) => {
      for (const r of rows) {
        if (!r.ok) { report.rows.push({ line: r.line, name: r.name, status: 'error', message: r.message }); continue; }
        const saved = await this.records.insert(tx, clinicId, { ...r.value, phone: asE164(clinic, r.value.phone) }, `user:${staff.userId}`);
        if (saved.status === 'exists') report.rows.push({ line: r.line, name: r.name, status: 'skip', message: 'already on file with this name, date of birth and phone' });
        else { if (saved.status === 'saved' && saved.similar) similar.add(r.line); report.rows.push({ line: r.line, name: r.name, status: 'add', message: null }); }
      }
      if (body.dryRun) throw dryRun;
    }).catch((err: unknown) => { if (err !== dryRun) throw err; });
    // a kind of animal the file brings joins the clinic's list (the check before the import said so on its rows) while the
    // list has room; a row whose kind found none is imported all the same, and says so
    const species = rows.flatMap((r, i) => (r.ok && 'species' in r.value && report.rows[i]?.status === 'add' ? [r.value.species as string] : []));
    const over = leftOffList(clinic, 'species', species);
    rows.forEach((r, i) => {
      const row = report.rows[i]!;
      if (!r.ok || row.status !== 'add') return;
      const kind = 'species' in r.value ? (r.value.species as string) : null;
      const note = listRowNote(r.adds, kind && onList(over, kind) ? [kind] : []);
      if (kind && onList(over, kind)) report.counts.notListed++;
      row.message = [note, similar.has(r.line) ? 'someone else has this name and date of birth, on another phone' : null].filter(Boolean).join('; ') || null;
    });
    if (!body.dryRun && species.length) {
      await this.desk.updateSettings(clinicId, staff.userId, 'clinic.list.updated.species', clinicId, (stored) => {
        const c = ClinicConfig.parse(stored);
        const next = ClinicConfig.safeParse(withListValues(c, 'species', species));
        return next.success && next.data.lists?.species?.length !== c.lists?.species?.length ? { save: next.data, result: null } : { result: null };
      });
    }
    for (const r of report.rows) report.counts[r.status]++;
    return report;
  }

  /** Why a merge cannot be done, in the words the dialog shows. */
  private mergeRefused(problem: MergeProblem): never {
    if (problem === 'not_found') throw new NotFoundException({ error: 'not_found' });
    const message: Record<Exclude<MergeProblem, 'not_found'>, string> = {
      same_record: 'Choose two different records.',
      same_household: 'These two are already on the same number: merge the two pets instead, if they are one pet.',
      different_household_needed: 'Choose a record on another number.',
      no_phone: 'Both records need a phone number to merge their households.',
    };
    throw new ConflictException({ error: 'merge_refused', reason: problem, message: message[problem] });
  }

  /** Merging two records, before it is done: what would move, as counts. Nothing changes and nothing is read in clear for the answer. */
  @Post('merge/preview')
  @HttpCode(200)
  @Requires('patients:merge')
  @ApiOperation({ summary: 'What merging two records would move: the same pet twice, or the same owner on two numbers. Counts only; nothing changes.' })
  @ApiBody({ schema: schemaOf(PatientMerge) })
  @ApiOkResponse({ schema: schemaOf(PatientMergeCounts) })
  async mergePreview(@Param('clinicId') clinicId: string, @Body(new ZodPipe(PatientMerge)) body: z.infer<typeof PatientMerge>): Promise<PatientMergeCounts> {
    const clinic = await this.clinic(clinicId);
    const r = await this.removal.previewMerge(clinicId, body.kind, body.keepId, body.mergeId, industryPack(clinic.industry).identity === 'pet');
    if ('problem' in r) this.mergeRefused(r.problem);
    return r;
  }

  /**
   * Merges two records into the one kept: its appointments, calls, requests and texts move, and the
   * other record is deleted. A household merge puts every pet of the other number under the number
   * and owner kept. Audited with who, when, which ids and counts.
   */
  @Post('merge')
  @HttpCode(200)
  @Requires('patients:merge')
  @ApiOperation({ summary: 'Merge two records into the one kept (the same pet twice, or one owner on two numbers). Managers only. Audited with counts.' })
  @ApiBody({ schema: schemaOf(PatientMerge) })
  @ApiOkResponse({ schema: schemaOf(PatientMergeCounts) })
  @ApiConflictResponse({ description: 'The two cannot be merged; `reason` says why' })
  async merge(@Param('clinicId') clinicId: string, @Body(new ZodPipe(PatientMerge)) body: z.infer<typeof PatientMerge>, @CurrentStaff() staff: Staff): Promise<PatientMergeCounts> {
    const clinic = await this.clinic(clinicId);
    const r = await this.removal.merge(clinicId, body.kind, body.keepId, body.mergeId, staff.userId, industryPack(clinic.industry).identity === 'pet');
    if ('problem' in r) this.mergeRefused(r.problem);
    return r;
  }

  /** Deleting a record, before it is done: what would go, as counts. Nothing changes. */
  @Post(':patientId/delete/preview')
  @HttpCode(200)
  @Requires('patients:merge')
  @ApiOperation({ summary: 'What deleting a pet (or everyone on its number) would do: visits cancelled, visits kept with no name, requests emptied, calls unlinked. Counts only; nothing changes.' })
  @ApiBody({ schema: schemaOf(PatientDelete) })
  @ApiOkResponse({ schema: schemaOf(PatientDeleteCounts) })
  async deletePreview(@Param('clinicId') clinicId: string, @Param('patientId') id: string, @Body(new ZodPipe(PatientDelete)) body: z.infer<typeof PatientDelete>): Promise<PatientDeleteCounts> {
    await this.clinic(clinicId);
    const r = isUuid(id) ? await this.removal.previewDelete(clinicId, id, body.scope, this.now()) : null;
    if (!r) throw new NotFoundException({ error: 'not_found' });
    return r;
  }

  /**
   * Deletes a pet's record, or everyone on its number: its name, number, date of birth and details
   * are removed and its search keys go; visits still to come are cancelled; the row stays, empty,
   * so the visits that were still count. Audited per record, with counts.
   */
  @Post(':patientId/delete')
  @HttpCode(200)
  @Requires('patients:merge')
  @ApiOperation({ summary: 'Delete a pet\'s record (or every record on its number): personal details and search keys removed, visits to come cancelled, past visits kept with no name. Managers only. Audited.' })
  @ApiBody({ schema: schemaOf(PatientDelete) })
  @ApiOkResponse({ schema: schemaOf(PatientDeleteCounts) })
  async remove(@Param('clinicId') clinicId: string, @Param('patientId') id: string, @Body(new ZodPipe(PatientDelete)) body: z.infer<typeof PatientDelete>, @CurrentStaff() staff: Staff): Promise<PatientDeleteCounts> {
    await this.clinic(clinicId);
    const r = isUuid(id) ? await this.removal.delete(clinicId, id, body.scope, staff.userId, this.now()) : null;
    if (!r) throw new NotFoundException({ error: 'not_found' });
    // the visits it cancelled, to the clinic's webhooks; the patient's id is the deleted record's, which names nobody now
    for (const appointmentId of r.cancelled) {
      await this.events.emit(clinicId, { type: 'appointment.cancelled', key: appointmentId, data: { appointmentId, patientId: id, by: 'staff', callId: null, reason: 'other' } });
    }
    return r.counts;
  }

  private answer(r: SaveResult): PatientSaved {
    if (r.status === 'not_found') throw new NotFoundException({ error: 'not_found' });
    if (r.status === 'exists') throw new ConflictException({ error: 'patient_exists', id: r.id, message: 'This patient is already on file: the same name, date of birth and phone number.' });
    return { id: r.id, similar: r.similar };
  }
}
