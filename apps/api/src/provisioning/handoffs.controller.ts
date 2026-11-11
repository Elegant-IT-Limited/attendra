// SPDX-License-Identifier: AGPL-3.0-only
import { ClinicConfig, HANDOFF_FIX_CATEGORIES, HANDOFF_LABELS, HANDOFF_REASONS, HANDOFF_VERDICTS } from '@attendra/core';
import { type Database, handoffWeeks, listHandoffs, notNeededHandoffs, type FrontDeskRepository, type PhiCipher, setHandoffVerdict, viewHandoff } from '@attendra/db';
import { Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, Put, Query, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { z } from 'zod';
import { Public } from '../http/staff.guard';
import { CIPHER, CLOCK, DB, FRONT_DESK } from '../http/tokens';
import { ZodPipe } from '../http/zod.pipe';
import { ProvisioningToken } from './provisioning.controller';

/**
 * The handoff review loop for the Attendra team (note 47), through the hosting layer's back office: every handoff
 * across clinics, one with its masked excerpt, the team's verdict, the numbers by clinic, engine and week, and the
 * weekly list of "not needed" ones. Codes only, except the one excerpt a reviewer opens; every view and verdict is an
 * audit row with the reviewer's email. Never sent to Slack. Behind the provisioning token, like every hosting route.
 */
const email = z.email().max(200);
const day = z.iso.datetime({ offset: true }).transform((s) => new Date(s));
/** Clinic ids, comma-separated: an account's locations. */
const clinicIds = z.string().max(2000).transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)).pipe(z.array(z.string().max(64)).max(50));
const HandoffQuery = z.object({
  orgId: z.string().max(64).optional(), clinicId: z.string().max(64).optional(), clinicIds: clinicIds.optional(),
  reason: z.enum(HANDOFF_REASONS).optional(), engine: z.enum(['gpt-live', 'gpt-realtime', 'vapi', 'unknown']).optional(),
  verdict: z.enum([...HANDOFF_VERDICTS, 'unreviewed']).optional(),
  from: day.optional(), to: day.optional(), limit: z.coerce.number().int().min(1).max(500).optional(),
});
const Viewer = z.object({ viewer: email });
const Verdict = z.object({ verdict: z.enum(HANDOFF_VERDICTS), fixCategory: z.enum(HANDOFF_FIX_CATEGORIES).nullable(), by: email });
const Weeks = z.object({ orgId: z.string().max(64).optional(), clinicId: z.string().max(64).optional(), clinicIds: clinicIds.optional(), from: day, to: day });
const Period = z.object({ from: day, to: day });
const ExcerptSwitch = z.object({ on: z.boolean() });
const uuid = z.uuid();

@ApiExcludeController()
@Public()
@UseGuards(ProvisioningToken)
@Controller('provisioning')
export class HandoffsController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CIPHER) private readonly cipher: PhiCipher,
    @Inject(FRONT_DESK) private readonly desk: FrontDeskRepository,
    @Inject(CLOCK) private readonly now: () => Date,
  ) {}

  /** Handoffs across clinics, newest first, with the filters; the labels for each code come with them. No excerpt. */
  @Get('handoffs')
  async list(@Query(new ZodPipe(HandoffQuery)) q: z.infer<typeof HandoffQuery>) {
    return { handoffs: await listHandoffs(this.db, q), labels: HANDOFF_LABELS };
  }

  /** Numbers by clinic, engine and week in [from, to): calls, calls with a handoff, handoffs, reviewed, "not needed", reasons. */
  @Get('handoffs/weeks')
  async weeks(@Query(new ZodPipe(Weeks)) q: z.infer<typeof Weeks>) {
    return { weeks: await handoffWeeks(this.db, q), labels: HANDOFF_LABELS };
  }

  /** Every handoff marked "not needed" whose review falls in [from, to): the weekly export, codes only. */
  @Get('handoffs/not-needed')
  async notNeeded(@Query(new ZodPipe(Period)) q: z.infer<typeof Period>) {
    return { handoffs: await notNeededHandoffs(this.db, q), labels: HANDOFF_LABELS };
  }

  /** One handoff with its masked excerpt (if the clinic keeps them), audited with the reviewer who opened it. */
  @Get('clinics/:clinicId/handoffs/:id')
  async one(@Param('clinicId') clinicId: string, @Param('id') id: string, @Query(new ZodPipe(Viewer)) q: z.infer<typeof Viewer>) {
    if (!uuid.safeParse(id).success) throw new NotFoundException({ error: 'not_found' });
    const h = await viewHandoff(this.db, this.cipher, clinicId, id, q.viewer);
    if (!h) throw new NotFoundException({ error: 'not_found' });
    return { handoff: h, labels: HANDOFF_LABELS };
  }

  /** The team's verdict and the kind of fix it needs, audited with who set it. */
  @Put('clinics/:clinicId/handoffs/:id/verdict')
  @HttpCode(204)
  async verdict(@Param('clinicId') clinicId: string, @Param('id') id: string, @Body(new ZodPipe(Verdict)) body: z.infer<typeof Verdict>) {
    if (!uuid.safeParse(id).success || !(await setHandoffVerdict(this.db, clinicId, id, body, this.now()))) throw new NotFoundException({ error: 'not_found' });
  }

  /**
   * Whether the clinic keeps a masked excerpt with each handoff (Level 2): on for an internal test clinic, or an account
   * whose accepted terms include the review line; the hosting layer decides and sets it. Off keeps codes only.
   */
  @Put('clinics/:clinicId/handoff-excerpts')
  @HttpCode(204)
  async excerpts(@Param('clinicId') clinicId: string, @Body(new ZodPipe(ExcerptSwitch)) body: z.infer<typeof ExcerptSwitch>) {
    const done = await this.desk.updateSettings(clinicId, 'provisioning', `clinic.handoff_excerpts.${body.on ? 'on' : 'off'}`, clinicId, (current) => {
      const c = ClinicConfig.parse(current);
      if ((c.handoffExcerpts ?? false) === body.on) return { result: true };
      return { save: { ...c, handoffExcerpts: body.on }, result: true };
    });
    if (!done) throw new NotFoundException({ error: 'not_found' });
  }
}
