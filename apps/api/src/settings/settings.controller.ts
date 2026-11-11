// SPDX-License-Identifier: AGPL-3.0-only
import { applyListChange, ClinicConfig, SETTINGS_LIMITS, EmergencyDraft, emergencyFormFor, emergencyFormView, emergencyNumberProblem, phoneTypingIssues, settingsFieldProblems, inClinicCountry, LANGUAGES, LIST_NAMES, type ListName, PACKS, PREVIEW_VOICES, viewerConfig, voiceLabel, withPhonesAsE164 } from '@attendra/core';
import { can } from '../access';
import { type Database, type FrontDeskRepository, PostgresAuditLog, type ScheduleRepository, schema, staffNames } from '@attendra/db';
import { and, eq } from 'drizzle-orm';
import { Body, ConflictException, Controller, Get, Headers, HttpCode, Inject, NotFoundException, Param, Post, Put, Query, Res, UnprocessableEntityException } from '@nestjs/common';
import { ApiBody, ApiConflictResponse, ApiCookieAuth, ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiTags, ApiUnprocessableEntityResponse } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { schemaOf } from '../http/openapi';
import { CurrentStaff, Requires, type Staff } from '../http/staff.guard';
import { API_OPTIONS, type ApiOptions, CLOCK, DB, FRONT_DESK, SCHEDULE } from '../http/tokens';
import { issuesOf, ZodPipe } from '../http/zod.pipe';
import { AssistantChoices, AssistantChoicesQuery, KeepStrandedQuery, ListChange } from '../contracts';
import { keeps, strandedBy, strandedConflict } from '../schedule/stranded';
import type { z } from 'zod';

@ApiTags('settings')
@ApiCookieAuth()
@ApiParam({ name: 'clinicId', example: 'clinic_maple' })
@Controller('clinics/:clinicId/settings')
export class SettingsController {
  constructor(
    @Inject(FRONT_DESK) private readonly desk: FrontDeskRepository, @Inject(API_OPTIONS) private readonly options: ApiOptions, @Inject(DB) private readonly db: Database, @Inject(CLOCK) private readonly now: () => Date,
    @Inject(SCHEDULE) private readonly schedule: ScheduleRepository,
  ) {}

  @Get()
  @Requires('clinic:read')
  @ApiOperation({ summary: 'The clinic configuration the voice agent runs with. The ETag is its version: send it back as If-Match when saving. A viewer gets it without vets\' private numbers, transfer numbers and the callers put straight through.' })
  @ApiOkResponse({ schema: schemaOf(ClinicConfig) })
  async get(@Param('clinicId') clinicId: string, @Res({ passthrough: true }) reply: FastifyReply, @CurrentStaff() staff: Staff): Promise<ClinicConfig> {
    const stored = await this.desk.settingsVersioned(clinicId);
    if (!stored) throw new NotFoundException({ error: 'not_found' });
    reply.header('etag', etag(stored.version)).header('cache-control', 'no-store');
    if (stored.updatedAt) reply.header('last-modified', stored.updatedAt.toUTCString());
    const config = ClinicConfig.parse(stored.config);
    return can(staff.role!, 'settings:read') ? config : viewerConfig(config);
  }

  @Get('meta')
  @Requires('settings:read')
  @ApiOperation({ summary: 'The settings\' version, when they were last saved and by whom' })
  async meta(@Param('clinicId') clinicId: string) {
    const stored = await this.desk.settingsVersioned(clinicId);
    if (!stored) throw new NotFoundException({ error: 'not_found' });
    // the numbers calls come in on (the assistant's own), so the page can tell them from the clinic's line
    const assistantNumbers = await this.assistantNumbers(clinicId);
    return { version: stored.version, assistantNumbers, ...(await this.who(clinicId, stored)) };
  }

  /**
   * For a setup page that names the assistant: the voices it can play a sample of, and the
   * greeting each language suggests for a name. A greeting the clinic never changed follows
   * the name; one it wrote itself is kept.
   */
  @Get('assistant')
  @Requires('settings:read')
  @ApiOperation({ summary: 'The voices with a sample, and the greeting suggested for an assistant name, with whether the saved greeting is still the suggested one' })
  @ApiOkResponse({ schema: schemaOf(AssistantChoices) })
  async assistant(@Param('clinicId') clinicId: string, @Query(new ZodPipe(AssistantChoicesQuery)) q: z.infer<typeof AssistantChoicesQuery>): Promise<AssistantChoices> {
    const stored = await this.desk.settings(clinicId);
    if (!stored) throw new NotFoundException({ error: 'not_found' });
    const c = ClinicConfig.parse(stored);
    const suggest = (assistantName: string | null) => PACKS[c.primaryLanguage].greeting({ assistantName, clinicName: c.name });
    return {
      voices: PREVIEW_VOICES.map((id) => ({ id, label: voiceLabel(id) })),
      suggested: Object.fromEntries(LANGUAGES.map((l) => [l, PACKS[l].greeting({ assistantName: (q.assistantName ?? c.assistantName)?.trim() || null, clinicName: c.name })])),
      savedIsSuggested: c.greeting === suggest(c.assistantName?.trim() || null),
      limits: SETTINGS_LIMITS,
    };
  }

  /**
   * The emergency form for the hosted setup page (batch 1e): the same choices, wording and limits Settings > Emergencies
   * reads from core, and the saved setting as the form's draft. One source for the words on both pages.
   */
  @Get('emergencies')
  @Requires('settings:read')
  @ApiOperation({ summary: 'The emergency form: its three choices, every label and hint, the limits, and the saved setting as a draft (the same constants Settings > Emergencies uses)' })
  async emergencyForm(@Param('clinicId') clinicId: string) {
    return emergencyFormFor(await this.config(clinicId));
  }

  /**
   * A draft of the emergency form, checked as Settings checks it: what is still needed, the setting it makes (null
   * until complete; save it with PUT as `emergencies`), the "Right now" line and what callers will hear. Saves nothing.
   */
  @Post('emergencies/preview')
  @HttpCode(200)
  @Requires('settings:read')
  @ApiOperation({ summary: 'Check an emergency form draft: { issues, setting, callLine, preview }, built by the same schema, route and preview as Settings > Emergencies. ?for=setup: the setup page wording for a clinic with no setting ("Choose one below."). Saves nothing.' })
  @ApiBody({ schema: schemaOf(EmergencyDraft) })
  async emergencyPreview(@Param('clinicId') clinicId: string, @Body(new ZodPipe(EmergencyDraft)) draft: z.infer<typeof EmergencyDraft>, @Query('for') place?: string) {
    // the setup page has the choices under its "Right now" line: ?for=setup says "Choose one below." instead of pointing to Settings
    return emergencyFormView(await this.config(clinicId), draft, this.now(), place === 'setup' ? 'setup' : 'settings');
  }

  private async config(clinicId: string): Promise<ClinicConfig> {
    const stored = await this.desk.settings(clinicId);
    if (!stored) throw new NotFoundException({ error: 'not_found' });
    return ClinicConfig.parse(stored);
  }

  /**
   * One of the clinic's lists, saved whole and in order, with renames: a renamed
   * specialty or category is renamed on every doctor, a removed one taken off them,
   * in the same change. Row-locked like the Doctors page, so it never undoes a save.
   */
  @Put('lists/:list')
  @Requires('settings:write')
  @ApiOperation({ summary: 'Save one list (specialties, categories, species) in order, with renames carried to every doctor. Audited.' })
  @ApiBody({ schema: schemaOf(ListChange) })
  @ApiOkResponse({ schema: schemaOf(ClinicConfig) })
  async list(@Param('clinicId') clinicId: string, @Param('list') list: string, @Body(new ZodPipe(ListChange)) body: z.infer<typeof ListChange>, @CurrentStaff() staff: Staff): Promise<ClinicConfig> {
    if (!(LIST_NAMES as readonly string[]).includes(list)) throw new NotFoundException({ error: 'not_found' });
    const out = await this.desk.updateSettings<ClinicConfig | { issues: { path: string; message: string }[] }>(clinicId, staff.userId, `clinic.list.updated.${list}`, clinicId, (stored) => {
      const next = ClinicConfig.safeParse(applyListChange(ClinicConfig.parse(stored), list as ListName, body.values, body.renamed));
      if (!next.success) return { result: { issues: issuesOf(next.error) } };
      return { save: next.data, result: next.data };
    });
    if (!out) throw new NotFoundException({ error: 'not_found' });
    if ('issues' in out) throw new UnprocessableEntityException({ error: 'invalid_settings', issues: out.issues });
    return out;
  }

  /** 409 with the newer settings, so the page can show what changed and merge. */
  private async conflict(clinicId: string, userId: string): Promise<never> {
    await new PostgresAuditLog(this.db).record(clinicId, { actor: `user:${userId}`, action: 'clinic.settings.conflict', entity: 'clinic', entityId: clinicId });
    const theirs = (await this.desk.settingsVersioned(clinicId))!;
    throw new ConflictException({ error: 'settings_changed', version: theirs.version, ...(await this.who(clinicId, theirs)), current: ClinicConfig.parse(theirs.config) });
  }

  private async who(clinicId: string, s: { updatedAt: Date | null; updatedBy: string | null }) {
    const names = s.updatedBy ? await staffNames(this.db, clinicId, [s.updatedBy]) : new Map<string, string>();
    // the hosting layer switches texting on itself; it is not a person on the team
    return { updatedAt: s.updatedAt?.toISOString() ?? null, updatedBy: s.updatedBy ? { name: s.updatedBy === 'provisioning' ? 'Attendra' : names.get(s.updatedBy) ?? 'A former team member' } : null };
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
  @ApiConflictResponse({ description: 'settings_changed: someone saved since the If-Match version; the body has theirs as `current`. strands_visits: the hours, holidays or special days would leave booked visits outside any bookable time (StrandedVisits); send it again with ?keepStranded=true to keep them' })
  @ApiQuery({ name: 'keepStranded', required: false, enum: ['true', 'false'], description: 'Keep the booked visits this save leaves outside the hours where they are (audited)' })
  async put(@Param('clinicId') clinicId: string, @Body() body: unknown, @CurrentStaff() staff: Staff, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) reply: FastifyReply,
    @Query(new ZodPipe(KeepStrandedQuery)) q: z.infer<typeof KeepStrandedQuery> = {}): Promise<ClinicConfig> {
    // without If-Match (older clients, scripts) the save goes through as before
    const expectedVersion = ifMatch ? versionOf(ifMatch) : undefined;
    if (ifMatch && expectedVersion === undefined) throw new UnprocessableEntityException({ error: 'invalid_settings', issues: [{ path: 'If-Match', message: 'expected the ETag from the last read, like "v3"' }] });
    // numbers only, before anything is normalised: letters would otherwise be dropped silently
    const lettered = phoneTypingIssues(body);
    if (lettered.length) throw new UnprocessableEntityException({ error: 'invalid_settings', issues: lettered });
    // every number as E.164 before the check, however it was typed: "(303) 555-0100" is not refused for its missing +1
    const typed = body && typeof body === 'object' && Array.isArray((body as { phoneNumbers?: unknown }).phoneNumbers) ? withPhonesAsE164(body as Parameters<typeof withPhonesAsE164>[0]) : body;
    const parsed = ClinicConfig.safeParse(typed);
    if (!parsed.success) throw new UnprocessableEntityException({ error: 'invalid_settings', issues: issuesOf(parsed.error) });
    const stored = await this.desk.settingsVersioned(clinicId);
    if (!stored) throw new NotFoundException({ error: 'not_found' });
    // a stale copy is a conflict before anything else: its problems may already be fixed in the newer one
    if (expectedVersion !== undefined && stored.version !== expectedVersion) await this.conflict(clinicId, staff.userId);
    const current = ClinicConfig.parse(stored.config);
    // Doctors are changed on the Doctors page. Settings keeps the ones on file, so a
    // Settings page opened before a doctor was added cannot remove them; a visit type
    // removed here is taken off every doctor who offered it.
    // Their order is Settings' to change (Booking rules, "in the order below"): the ones on file, in the
    // order sent, and any added since at the end
    const order = new Map(parsed.data.providers.map((p, i) => [p.id, i]));
    const ordered = [...current.providers].sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER));
    const providers = ordered.map((p) => ({ ...p, visitTypeIds: p.visitTypeIds.filter((id) => parsed.data.visitTypes.some((v) => v.id === id)) }));
    const stranded = providers.find((p) => !p.visitTypeIds.length);
    if (stranded) {
      throw new UnprocessableEntityException({ error: 'invalid_settings', issues: [{ path: 'visitTypes', message: `${stranded.name} would have no visit types left. Give them another one on the Doctors page first.` }] });
    }
    const merged = ClinicConfig.safeParse({ ...parsed.data, providers });
    if (!merged.success) throw new UnprocessableEntityException({ error: 'invalid_settings', issues: issuesOf(merged.error) });
    // the emergency review is recorded on its own route, by the person who did it; Settings keeps it as it is
    // and the voice engine is the operator's choice (provisioning), never Settings'
    // and so is a pause of the assistant (provisioning, from the plan), and the location's Vapi ids (batch 6)
    const next = { ...merged.data, emergencyReview: current.emergencyReview, voiceEngine: current.voiceEngine, voiceFlow: current.voiceFlow, realtimeModel: current.realtimeModel, answeringPaused: current.answeringPaused, handoffExcerpts: current.handoffExcerpts, vapi: current.vapi };
    if (next.id !== clinicId) throw new UnprocessableEntityException({ error: 'invalid_settings', issues: [{ path: 'id', message: 'the clinic id cannot change' }] });
    // the assistant's numbers are Attendra's (they route calls); the clinic's own lines are the clinic's to keep right.
    // In order: the assistant's first, as they were, since the first number is the one confirmations are texted from
    if (JSON.stringify(next.phoneNumbers) !== JSON.stringify(current.phoneNumbers)) {
      const assistant = await this.assistantNumbers(clinicId);
      const gone = current.phoneNumbers.find((n) => assistant.includes(n) && !next.phoneNumbers.includes(n));
      if (gone || next.phoneNumbers.some((n) => assistant.includes(n) && !current.phoneNumbers.includes(n))) {
        throw new UnprocessableEntityException({ error: 'invalid_settings', issues: [{ path: 'phoneNumbers', message: 'the assistant\'s numbers are managed on the Phone number page' }] });
      }
      const own = [...new Set(next.phoneNumbers.filter((n) => !assistant.includes(n)))];
      if (own.length > 3) throw new UnprocessableEntityException({ error: 'invalid_settings', issues: [{ path: 'phoneNumbers', message: 'up to 3 of your own lines' }] });
      const abroad = own.find((n) => !inClinicCountry(current, n));
      if (abroad) throw new UnprocessableEntityException({ error: 'invalid_settings', issues: [{ path: 'phoneNumbers', message: 'your own line must be in the clinic\'s country' }] });
      if (this.options.demoMode) throw new UnprocessableEntityException({ error: 'invalid_settings', issues: [{ path: 'phoneNumbers', message: 'numbers cannot be changed in demo mode' }] });
      next.phoneNumbers = [...current.phoneNumbers.filter((n) => assistant.includes(n)), ...own];
      if (!next.phoneNumbers.length) throw new UnprocessableEntityException({ error: 'invalid_settings', issues: [{ path: 'phoneNumbers', message: 'keep at least one number' }] });
    }
    // checked here, not in the schema: a number saved before the rule must not stop calls, and the voice service falls back to the country's
    // the field standard, checked on a change (a configuration saved before a limit still loads)
    const fields = settingsFieldProblems(next);
    if (fields.length) throw new UnprocessableEntityException({ error: 'invalid_settings', issues: fields });
    const emergency = emergencyNumberProblem(next);
    if (emergency) throw new UnprocessableEntityException({ error: 'invalid_settings', issues: [{ path: 'emergencyNumber', message: emergency }] });
    // A demo deployment can take real calls, so nobody signed in to it may send them somewhere new.
    if (this.options.demoMode && JSON.stringify(next.routing) !== JSON.stringify(current.routing)) {
      throw new UnprocessableEntityException({ error: 'invalid_settings', issues: [{ path: 'routing', message: 'transfer numbers cannot be changed in demo mode' }] });
    }
    // hours, holidays or special days that would leave booked visits outside any bookable time are never saved
    // silently: the "move or keep" list first, and with keepStranded those visits stay where they are, audited
    const now = this.now();
    const strands = await strandedBy(this.desk, clinicId, current, next, now);
    if (strands.length && !keeps(q)) throw await strandedConflict(this.schedule, clinicId, strands, staff);
    const saved = await this.desk.saveSettings(clinicId, next, staff.userId, undefined, { expectedVersion });
    if (saved.status === 'conflict') return this.conflict(clinicId, staff.userId);
    if (strands.length) await this.schedule.keepStranded(clinicId, strands.map((v) => v.id), staff.userId, now);
    reply.header('etag', etag(saved.version));
    return next;
  }

  /** The numbers calls come in on: the assistant's own, from provisioning. */
  private async assistantNumbers(clinicId: string): Promise<string[]> {
    return (await this.db.select({ e164: schema.phoneNumbers.e164 }).from(schema.phoneNumbers)
      .where(and(eq(schema.phoneNumbers.clinicId, clinicId), eq(schema.phoneNumbers.status, 'active')))).map((r) => r.e164);
  }
}

const etag = (version: number) => `"v${version}"`;
/** "v3", W/"v3" or v3: the version a client read. */
const versionOf = (header: string) => {
  const m = /^(?:W\/)?"?v(\d{1,9})"?$/.exec(header.trim());
  return m ? Number(m[1]) : undefined;
};
