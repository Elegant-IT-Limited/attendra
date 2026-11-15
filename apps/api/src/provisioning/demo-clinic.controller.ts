// SPDX-License-Identifier: AGPL-3.0-only
import { type Database, demoActor, demoResetLine, demoState, type PhiCipher, resetDemoClinic, setDemoBaseline, setDemoSwitch } from '@attendra/db';
import type { Alerter } from '@attendra/observability';
import { Body, Controller, Get, HttpCode, HttpException, Inject, NotFoundException, Param, Post, Put, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { z } from 'zod';
import { Public } from '../http/staff.guard';
import { ALERTS, CIPHER, CLOCK, DB } from '../http/tokens';
import { ZodPipe } from '../http/zod.pipe';
import { ProvisioningToken } from './provisioning.controller';

/**
 * A demo clinic (2026-11-16, core demo-clinic.ts), for the hosting layer's back office: the switch, its baseline and a
 * reset now. The hosting layer decides who may have one (only a clinic its operator marked as an internal test clinic,
 * never one with a paying plan) and says who asked; every change here is an audit row with that email. Behind the
 * provisioning token, like every hosting route.
 */
const Actor = z.object({ actor: z.email().max(200) });
const DemoSwitch = Actor.extend({ enabled: z.boolean() });
const Reset = Actor.extend({ dryRun: z.boolean().optional() });

/** The engine's refusal codes, as statuses. */
const STATUS = { not_found: 404, not_demo: 409, no_baseline: 409, call_in_progress: 409 } as const;
const refuse = (error: keyof typeof STATUS) => new HttpException({ error }, STATUS[error]);

@ApiExcludeController()
@Public()
@UseGuards(ProvisioningToken)
@Controller('provisioning')
export class DemoClinicController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CIPHER) private readonly cipher: PhiCipher,
    @Inject(CLOCK) private readonly now: () => Date,
    @Inject(ALERTS) private readonly alerts: Alerter | null,
  ) {}

  /** On or off, the baseline (when, by whom, rows per table) and the last reset (when, what it changed): counts only. */
  @Get('clinics/:clinicId/demo')
  async state(@Param('clinicId') clinicId: string) {
    const s = await demoState(this.db, clinicId);
    if (!s) throw new NotFoundException({ error: 'not_found' });
    return s;
  }

  /** Turns demo mode on or off, audited with who asked. The baseline is kept when it goes off, for when it comes back on. */
  @Put('clinics/:clinicId/demo')
  @HttpCode(204)
  async set(@Param('clinicId') clinicId: string, @Body(new ZodPipe(DemoSwitch)) body: z.infer<typeof DemoSwitch>) {
    if ((await setDemoSwitch(this.db, clinicId, body.enabled, demoActor(body.actor), this.now())) === 'not_found') throw new NotFoundException({ error: 'not_found' });
  }

  /** "Set demo baseline now": the clinic's pets, owners, visits and requests as they are now, kept for the nightly reset. */
  @Post('clinics/:clinicId/demo/baseline')
  @HttpCode(200)
  async baseline(@Param('clinicId') clinicId: string, @Body(new ZodPipe(Actor)) body: z.infer<typeof Actor>) {
    const r = await setDemoBaseline(this.db, this.cipher, clinicId, demoActor(body.actor), this.now());
    if (!r.ok) throw refuse(r.error);
    return r;
  }

  /** "Reset demo now": the baseline put back now (the nightly run does the same at 03:30 clinic time). Refused while a call is going. */
  @Post('clinics/:clinicId/demo/reset')
  @HttpCode(200)
  async reset(@Param('clinicId') clinicId: string, @Body(new ZodPipe(Reset)) body: z.infer<typeof Reset>) {
    const r = await resetDemoClinic(this.db, this.cipher, clinicId, demoActor(body.actor), this.now(), { dryRun: body.dryRun });
    if (!r.ok) throw refuse(r.error);
    // Slack hears every reset, counts only, as it hears the nightly ones
    if (!body.dryRun) this.alerts?.note(`Demo clinic reset (from the back office), clinic ${clinicId}: ${demoResetLine(r.counts)}.`);
    return { ...r, dryRun: body.dryRun ?? false };
  }
}
