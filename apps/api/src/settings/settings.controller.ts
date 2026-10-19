// SPDX-License-Identifier: AGPL-3.0-only
import { applyListChange, ClinicConfig, emergencyNumberProblem, LIST_NAMES, type ListName } from '@attendra/core';
import { type Database, type FrontDeskRepository, PostgresAuditLog, staffNames } from '@attendra/db';
import { Body, ConflictException, Controller, Get, Headers, Inject, NotFoundException, Param, Put, Res, UnprocessableEntityException } from '@nestjs/common';
import { ApiBody, ApiConflictResponse, ApiCookieAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags, ApiUnprocessableEntityResponse } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { schemaOf } from '../http/openapi';
import { CurrentStaff, Requires, type Staff } from '../http/staff.guard';
import { API_OPTIONS, type ApiOptions, DB, FRONT_DESK } from '../http/tokens';
import { issuesOf, ZodPipe } from '../http/zod.pipe';
import { ListChange } from '../contracts';
import type { z } from 'zod';

@ApiTags('settings')
@ApiCookieAuth()
@ApiParam({ name: 'clinicId', example: 'clinic_maple' })
@Controller('clinics/:clinicId/settings')
export class SettingsController {
  constructor(@Inject(FRONT_DESK) private readonly desk: FrontDeskRepository, @Inject(API_OPTIONS) private readonly options: ApiOptions, @Inject(DB) private readonly db: Database) {}

  @Get()
  @Requires('settings:read')
  @ApiOperation({ summary: 'The clinic configuration the voice agent runs with. The ETag is its version: send it back as If-Match when saving.' })
  @ApiOkResponse({ schema: schemaOf(ClinicConfig) })
  async get(@Param('clinicId') clinicId: string, @Res({ passthrough: true }) reply: FastifyReply): Promise<ClinicConfig> {
    const stored = await this.desk.settingsVersioned(clinicId);
    if (!stored) throw new NotFoundException({ error: 'not_found' });
    reply.header('etag', etag(stored.version)).header('cache-control', 'no-store');
    if (stored.updatedAt) reply.header('last-modified', stored.updatedAt.toUTCString());
    return ClinicConfig.parse(stored.config);
  }

  @Get('meta')
  @Requires('settings:read')
  @ApiOperation({ summary: 'The settings\' version, when they were last saved and by whom' })
  async meta(@Param('clinicId') clinicId: string) {
    const stored = await this.desk.settingsVersioned(clinicId);
    if (!stored) throw new NotFoundException({ error: 'not_found' });
    return { version: stored.version, ...(await this.who(clinicId, stored)) };
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
  @ApiConflictResponse({ description: 'settings_changed: someone saved since the If-Match version; the body has theirs as `current`' })
  async put(@Param('clinicId') clinicId: string, @Body() body: unknown, @CurrentStaff() staff: Staff, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) reply: FastifyReply): Promise<ClinicConfig> {
    // without If-Match (older clients, scripts) the save goes through as before
    const expectedVersion = ifMatch ? versionOf(ifMatch) : undefined;
    if (ifMatch && expectedVersion === undefined) throw new UnprocessableEntityException({ error: 'invalid_settings', issues: [{ path: 'If-Match', message: 'expected the ETag from the last read, like "v3"' }] });
    const parsed = ClinicConfig.safeParse(body);
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
    const next = { ...merged.data, emergencyReview: current.emergencyReview, voiceEngine: current.voiceEngine };
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
    const saved = await this.desk.saveSettings(clinicId, next, staff.userId, undefined, { expectedVersion });
    if (saved.status === 'conflict') return this.conflict(clinicId, staff.userId);
    reply.header('etag', etag(saved.version));
    return next;
  }
}

const etag = (version: number) => `"v${version}"`;
/** "v3", W/"v3" or v3: the version a client read. */
const versionOf = (header: string) => {
  const m = /^(?:W\/)?"?v(\d{1,9})"?$/.exec(header.trim());
  return m ? Number(m[1]) : undefined;
};
