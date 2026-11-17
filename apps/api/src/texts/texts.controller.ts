// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, ClinicConfig, localDateOf, TEXT_GROUPS, type TextGroup, zonedInstant } from '@attendra/core';
import type { FrontDeskRepository } from '@attendra/db';
import { Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { can, type Permission } from '../access';
import { TextHandled, TextList, TextPage, TextQuery, TextSearch, TextSummary } from '../contracts';
import { schemaOf } from '../http/openapi';
import { CurrentStaff, Requires, type Staff } from '../http/staff.guard';
import { CLOCK, FRONT_DESK } from '../http/tokens';
import { ZodPipe } from '../http/zod.pipe';

const iso = (d: Date | null) => d?.toISOString() ?? null;
type Row = Awaited<ReturnType<FrontDeskRepository['texts']>>[number];
const item = (r: Row): TextList['texts'][number] => ({
  ...r, kind: r.kind as TextList['texts'][number]['kind'], status: r.status as TextList['texts'][number]['status'],
  createdAt: r.createdAt.toISOString(), sentAt: iso(r.sentAt), deliveredAt: iso(r.deliveredAt), appointmentStartsAt: iso(r.appointmentStartsAt), handledAt: iso(r.handledAt),
});

/** Whether a text went, for staff: on the call, the request, the pet or patient, the visit, and the clinic's Texts page. */
@ApiTags('texts')
@ApiCookieAuth()
@ApiParam({ name: 'clinicId', example: 'clinic_maple' })
@Controller('clinics/:clinicId/texts')
export class TextsController {
  constructor(@Inject(FRONT_DESK) private readonly desk: FrontDeskRepository, @Inject(CLOCK) private readonly now: () => Date) {}

  @Get()
  @Requires('calls:read')
  @ApiOperation({ summary: 'The texts about one call, request or appointment, to one pet\'s or patient\'s household (20), or the clinic\'s newest (50, all or not sent): kind, sent, delivered or why not, the words that went out (while call records are kept), what each belongs to and the pet it is about. Owners, managers and front desk; every read is audited.' })
  @ApiOkResponse({ schema: schemaOf(TextList) })
  async list(@Param('clinicId') clinicId: string, @Query(new ZodPipe(TextQuery)) q: z.infer<typeof TextQuery>, @CurrentStaff() staff: Staff): Promise<TextList> {
    // the words that went out are caller data: the roles that read calls and records (never a viewer)
    const needs: Permission = q.callId ? 'calls:read' : q.taskId ? 'tasks:read' : 'patients:read';
    if (!staff.role || !can(staff.role, needs)) throw new ForbiddenException();
    const rows = await this.desk.texts(clinicId, q, staff.userId);
    return { texts: rows.map(item), wordsKeptSince: iso(await this.desk.wordsKeptSince()) };
  }

  /** A POST, not a GET: the words typed can be a name or a phone number, and URLs end up in logs. */
  @Post('search')
  @HttpCode(200)
  @Requires('patients:read')
  @ApiOperation({ summary: 'The Texts page: the clinic\'s texts, newest first, a page at a time (10 by default, 50 at most; `next` for the page after), by status (all, sent, not sent, not sent and not handled), kind or group of kinds, clinic-local days, and words: a request number (R-12), a pet\'s or owner\'s name, or digits of their number. Audited as one view.' })
  @ApiBody({ schema: schemaOf(TextSearch) })
  @ApiOkResponse({ schema: schemaOf(TextPage) })
  async search(@Param('clinicId') clinicId: string, @Body(new ZodPipe(TextSearch)) b: z.infer<typeof TextSearch>, @CurrentStaff() staff: Staff): Promise<TextPage> {
    const tz = (await this.clinic(clinicId)).timezone;
    const templates = b.kind ? (TEXT_GROUPS[b.kind as TextGroup] ?? [b.kind]) : undefined;
    const [at, id] = b.cursor?.split('|') ?? [];
    const page = await this.desk.searchTexts(clinicId, {
      search: b.q || undefined, status: b.status, templates,
      from: b.from ? zonedInstant(b.from, '00:00', tz) : undefined, to: b.to ? zonedInstant(addDays(b.to, 1), '00:00', tz) : undefined,
      before: at && id ? { at: new Date(at), id } : undefined, limit: b.limit,
    }, staff.userId);
    return { texts: page.texts.map(item), next: page.next ? `${page.next.at.toISOString()}|${page.next.id}` : null, wordsKeptSince: iso(await this.desk.wordsKeptSince()) };
  }

  @Get('summary')
  @Requires('patients:read')
  @ApiOperation({ summary: 'Today\'s and the last 7 days\' texts (clinic-local days), sent and not sent, and how many not sent nobody has handled. Counts only; not audited.' })
  @ApiOkResponse({ schema: schemaOf(TextSummary) })
  async summary(@Param('clinicId') clinicId: string): Promise<TextSummary> {
    const tz = (await this.clinic(clinicId)).timezone;
    const todayDate = localDateOf(this.now(), tz);
    const weekFrom = addDays(todayDate, -6);
    const counts = await this.desk.textSummary(clinicId, { today: zonedInstant(todayDate, '00:00', tz), week: zonedInstant(weekFrom, '00:00', tz) });
    return { ...counts, todayDate, weekFrom };
  }

  /** A text not sent, marked handled (someone called the owner instead), or back to not handled. */
  @Post(':textId/handled')
  @HttpCode(200)
  @Requires('tasks:work')
  @ApiOperation({ summary: 'Mark a text that was not sent as handled, or not: it leaves Today and the notice, with who and when. Audited. Only a text that was not sent.' })
  @ApiBody({ schema: schemaOf(TextHandled) })
  @ApiOkResponse({ schema: schemaOf(z.object({ handled: z.boolean() })) })
  async handled(@Param('clinicId') clinicId: string, @Param('textId') textId: string, @Body(new ZodPipe(TextHandled)) b: z.infer<typeof TextHandled>, @CurrentStaff() staff: Staff) {
    if (!z.uuid().safeParse(textId).success) throw new NotFoundException({ error: 'not_found' });
    const r = await this.desk.markTextHandled(clinicId, textId, b.handled, staff.userId);
    if (r === 'not_found') throw new NotFoundException({ error: 'not_found' });
    if (r === 'was_sent') throw new ConflictException({ error: 'text_was_sent', message: 'This text went out: there is nothing to handle.' });
    return { handled: b.handled };
  }

  private async clinic(clinicId: string) {
    const stored = await this.desk.settings(clinicId);
    if (!stored) throw new NotFoundException({ error: 'not_found' });
    return ClinicConfig.parse(stored);
  }
}
