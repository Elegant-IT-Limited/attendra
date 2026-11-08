// SPDX-License-Identifier: AGPL-3.0-only
import { allVisitTypeIds, ClinicConfig, configProblems, leftOffList, listRowNote, newProviderId, noProviderWarnings, notOnListProblem, onList, type Provider, providerPhoneIssues, readCustomValues, readDoctors, withListValues } from '@attendra/core';
import type { FrontDeskRepository, ScheduleRepository, Tx } from '@attendra/db';
import { Body, ConflictException, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Post, Put, Query, UnprocessableEntityException } from '@nestjs/common';
import { ApiBody, ApiConflictResponse, ApiCookieAuth, ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiTags, ApiUnprocessableEntityResponse } from '@nestjs/swagger';
import type { z } from 'zod';
import { DoctorInput, DoctorList, ImportInput, ImportResult, KeepStrandedQuery } from '../contracts';
import { schemaOf } from '../http/openapi';
import { CurrentStaff, Requires, type Staff } from '../http/staff.guard';
import { CLOCK, FRONT_DESK, SCHEDULE } from '../http/tokens';
import { issuesOf, ZodPipe } from '../http/zod.pipe';
import { keeps, type StrandedHit, strandedBy, strandedConflict } from '../schedule/stranded';

type Issues = ReturnType<typeof issuesOf>;
type Change = { config: ClinicConfig } | { error: string; status: 404 | 409 | 422 } | { issues: Issues };
type Outcome = Exclude<Change, { config: ClinicConfig }> | { config: ClinicConfig; kept: StrandedHit[] } | { stranded: StrandedHit[] };

/**
 * The clinic's doctors, and rooms booked like one: who they are, what they see people
 * for, the ages they see, their weekly hours and their days off. They live in the
 * clinic's settings, which the voice service reads again before every request on a
 * call, so the assistant knows a change from the next thing a caller asks.
 */
/**
 * A doctor's own details, checked against the clinic's fields for doctors. A form that
 * sends none (an older page, an import) keeps what the doctor had.
 */
function customOf(c: ClinicConfig, sent: Record<string, string> | undefined, kept: Record<string, string> | undefined): { values: Record<string, string> | undefined } | { error: string; status: 422 } {
  if (sent === undefined) return { values: kept };
  const read = readCustomValues(c.providerFields ?? [], sent, { complete: true });
  if (!read.ok) return { error: `${(c.providerFields ?? []).find((f) => f.id === read.field)?.label ?? 'A field'}: ${read.message}`, status: 422 };
  return { values: Object.keys(read.values).length ? read.values : undefined };
}

/**
 * A specialty and categories come from the clinic's lists (Settings, Fields and lists): a value
 * not on them is refused under its field, so the page's filters and the lists show every value
 * in use. What the doctor already has is kept as it is, on the list or not, so nothing is lost.
 */
function listIssues(c: ClinicConfig, body: { specialty?: string; categories: string[] }, current?: Provider): Issues {
  const specialty = notOnListProblem(c, 'specialties', body.specialty ? [body.specialty] : [], current?.specialty ? [current.specialty] : []);
  const categories = notOnListProblem(c, 'categories', body.categories, current?.categories ?? []);
  return [...(specialty ? [{ path: 'specialty', message: specialty }] : []), ...(categories ? [{ path: 'categories', message: categories }] : [])];
}

/** The lists and the numbers checked together, so the form shows every problem at once, each under its field. */
function fieldIssues(c: ClinicConfig, body: z.infer<typeof DoctorInput>, current?: Provider): { issues: Issues } | { phone?: string; otherPhones?: string[] } {
  const phones = providerPhoneIssues(c, body, current?.id);
  const issues = [...listIssues(c, body, current), ...phones.issues];
  return issues.length ? { issues } : { phone: phones.phone, otherPhones: phones.otherPhones };
}

/**
 * The stand-in a new clinic starts with goes with the first change once a real doctor is listed,
 * unless a visit still points at it: then it stays in the settings, and the dashboard and the
 * assistant pass it by.
 */
async function withoutStandIn(desk: FrontDeskRepository, clinicId: string, providers: Provider[], tx: Tx): Promise<Provider[]> {
  if (!providers.some((p) => !p.placeholder)) return providers;
  const keep: Provider[] = [];
  for (const p of providers) if (!p.placeholder || await desk.visitsWithProvider(clinicId, p.id, tx)) keep.push(p);
  return keep;
}

/** The doctors, the visit types, and a warning for each type nobody does (the same words Settings shows). */
const listOf = (c: ClinicConfig): DoctorList => ({ providers: c.providers, visitTypes: c.visitTypes, noProvider: noProviderWarnings(c) });

@ApiTags('doctors')
@ApiCookieAuth()
@ApiParam({ name: 'clinicId', example: 'clinic_maple' })
@Controller('clinics/:clinicId/doctors')
export class DoctorsController {
  constructor(@Inject(FRONT_DESK) private readonly desk: FrontDeskRepository, @Inject(CLOCK) private readonly now: () => Date, @Inject(SCHEDULE) private readonly schedule: ScheduleRepository) {}

  @Get()
  @Requires('settings:read')
  @ApiOperation({ summary: 'The doctors and the visit types they can be booked for' })
  @ApiOkResponse({ schema: schemaOf(DoctorList) })
  async list(@Param('clinicId') clinicId: string): Promise<DoctorList> {
    const stored = await this.desk.settings(clinicId);
    if (!stored) throw new NotFoundException({ error: 'not_found' });
    return listOf(ClinicConfig.parse(stored));
  }

  @Post()
  @HttpCode(201)
  @Requires('settings:write')
  @ApiOperation({ summary: 'Add a doctor. Audited. The assistant knows them from the next request on any call.' })
  @ApiBody({ schema: schemaOf(DoctorInput) })
  @ApiOkResponse({ schema: schemaOf(DoctorList) })
  async add(@Param('clinicId') clinicId: string, @Body(new ZodPipe(DoctorInput)) body: z.infer<typeof DoctorInput>, @CurrentStaff() staff: Staff): Promise<DoctorList> {
    const id = body.id ?? newProviderId(body.name);
    return this.change(clinicId, staff, 'clinic.doctor.added', id, null, (c) => {
      if (c.providers.some((p) => p.id === id)) return { error: `a doctor with the id ${id} is already on file`, status: 409 };
      const checked = fieldIssues(c, body);
      if ('issues' in checked) return checked;
      const custom = customOf(c, body.custom, undefined);
      if ('error' in custom) return custom;
      return { config: { ...c, providers: [...c.providers, { ...body, visitTypeIds: body.visitTypeIds ?? allVisitTypeIds(c), ...checked, id, custom: custom.values } as Provider] } };
    });
  }

  @Put(':providerId')
  @Requires('settings:write')
  @ApiOperation({ summary: 'Change a doctor: details, hours, days off. Audited.' })
  @ApiBody({ schema: schemaOf(DoctorInput) })
  @ApiOkResponse({ schema: schemaOf(DoctorList) })
  @ApiConflictResponse({ description: 'strands_visits: the hours or days off would leave booked visits outside any bookable time (StrandedVisits); send it again with ?keepStranded=true to keep them' })
  @ApiQuery({ name: 'keepStranded', required: false, enum: ['true', 'false'], description: 'Keep the booked visits this change leaves outside the doctor\'s hours where they are (audited)' })
  async update(@Param('clinicId') clinicId: string, @Param('providerId') providerId: string, @Body(new ZodPipe(DoctorInput)) body: z.infer<typeof DoctorInput>, @CurrentStaff() staff: Staff,
    @Query(new ZodPipe(KeepStrandedQuery)) q: z.infer<typeof KeepStrandedQuery> = {}): Promise<DoctorList> {
    // hours or days off that would leave booked visits outside any bookable time are never saved silently
    return this.change(clinicId, staff, 'clinic.doctor.updated', providerId, { keep: keeps(q) }, (c) => {
      const current = c.providers.find((p) => p.id === providerId);
      if (!current) return { error: 'not_found', status: 404 };
      const checked = fieldIssues(c, body, current);
      if ('issues' in checked) return checked;
      const custom = customOf(c, body.custom, current.custom);
      if ('error' in custom) return custom;
      return { config: { ...c, providers: c.providers.map((p) => (p.id === providerId ? { ...body, visitTypeIds: body.visitTypeIds ?? current.visitTypeIds, ...checked, id: providerId, custom: custom.values } as Provider : p)) } };
    });
  }

  @Delete(':providerId')
  @Requires('settings:write')
  @ApiOperation({ summary: 'Remove a doctor with no visits still to come. Audited.' })
  @ApiOkResponse({ schema: schemaOf(DoctorList) })
  @ApiConflictResponse({ description: 'They still have booked visits to come, or they are the last doctor' })
  async remove(@Param('clinicId') clinicId: string, @Param('providerId') providerId: string, @CurrentStaff() staff: Staff): Promise<DoctorList> {
    // counted with the settings row locked, so a booking made a moment before is seen
    return this.change(clinicId, staff, 'clinic.doctor.removed', providerId, null, async (c, tx) => {
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
    const out = await this.desk.updateSettings<{ report: ImportResult } | { issues: Issues }>(clinicId, staff.userId, 'clinic.doctors.imported', clinicId, async (stored, tx) => {
      const c = ClinicConfig.parse(stored);
      const rows = readDoctors(body.csv, c);
      const good = rows.flatMap((r) => (r.ok ? [r] : []));
      // a specialty or category the file brings joins the clinic's lists (the check before the import said so) while
      // they have room; a doctor whose value found none is imported all the same, and the row says so
      const specialties = good.flatMap((r) => (r.value.specialty ? [r.value.specialty] : []));
      const categories = good.flatMap((r) => r.value.categories);
      const over = { specialties: leftOffList(c, 'specialties', specialties), categories: leftOffList(c, 'categories', categories) };
      const overOf = (p: Provider) => [...(p.specialty && onList(over.specialties, p.specialty) ? [p.specialty] : []), ...p.categories.filter((v) => onList(over.categories, v))];
      const report: ImportResult = {
        dryRun: body.dryRun,
        rows: rows.map((r) => ({ line: r.line, name: r.name, status: r.ok ? (r.existingId ? 'update' : 'add') : 'error', message: r.ok ? listRowNote(r.adds, overOf(r.value)) : r.message })),
        counts: { add: 0, update: 0, skip: 0, error: 0, notListed: good.filter((r) => overOf(r.value).length).length },
      };
      for (const r of report.rows) report.counts[r.status]++;
      if (body.dryRun || !good.length) return { result: { report } };
      const providers = await withoutStandIn(this.desk, clinicId, c.providers.map((p) => good.find((r) => r.existingId === p.id)?.value ?? p).concat(good.filter((r) => !r.existingId).map((r) => r.value)), tx);
      const listed = withListValues(withListValues({ ...c, providers }, 'specialties', specialties), 'categories', categories);
      const parsed = ClinicConfig.safeParse(listed);
      if (!parsed.success) return { result: { issues: issuesOf(parsed.error) } };
      if (configProblems(parsed.data).length) return { result: { issues: configProblems(parsed.data) } };
      return { save: parsed.data, result: { report } };
    });
    if (!out) throw new NotFoundException({ error: 'not_found' });
    if ('issues' in out) throw new UnprocessableEntityException({ error: 'invalid_settings', issues: out.issues });
    return out.report;
  }

  /**
   * One change to the doctors, in one locked update of the settings. With `stranded`, a change that would leave booked
   * visits outside any bookable time is refused with the "move or keep" list, or saved with them kept where they are.
   */
  private async change(clinicId: string, staff: Staff, action: string, entityId: string, stranded: { keep: boolean } | null, fn: (c: ClinicConfig, tx: Tx) => Change | Promise<Change>): Promise<DoctorList> {
    const now = this.now();
    const out = await this.desk.updateSettings<Outcome>(clinicId, staff.userId, action, entityId, async (stored, tx) => {
      const before = ClinicConfig.parse(stored);
      const next = await fn(before, tx);
      if (!('config' in next)) return { result: next };
      next.config.providers = await withoutStandIn(this.desk, clinicId, next.config.providers, tx);
      // the same checks as saving Settings: ids unique, visit types that exist, hours that make sense
      const parsed = ClinicConfig.safeParse(next.config);
      if (!parsed.success) return { result: { issues: issuesOf(parsed.error) } };
      if (configProblems(parsed.data).length) return { result: { issues: configProblems(parsed.data) } };
      // read with the settings row locked, so a booking made a moment before is seen
      const hits = stranded ? await strandedBy(this.desk, clinicId, before, parsed.data, now, tx) : [];
      if (hits.length && !stranded?.keep) return { result: { stranded: hits } };
      return { save: parsed.data, result: { config: parsed.data, kept: hits } };
    });
    if (!out) throw new NotFoundException({ error: 'not_found' });
    if ('stranded' in out) throw await strandedConflict(this.schedule, clinicId, out.stranded, staff);
    if ('kept' in out && out.kept.length) await this.schedule.keepStranded(clinicId, out.kept.map((v) => v.id), staff.userId, now);
    if ('issues' in out) throw new UnprocessableEntityException({ error: 'invalid_doctor', issues: out.issues });
    if ('error' in out) {
      if (out.status === 404) throw new NotFoundException({ error: 'not_found' });
      if (out.status === 422) throw new UnprocessableEntityException({ error: 'invalid_request', issues: [{ path: 'custom', message: out.error }] });
      throw new ConflictException({ error: out.error.startsWith('They have') ? 'has_upcoming_visits' : 'conflict', message: out.error });
    }
    return listOf(out.config);
  }
}
