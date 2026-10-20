// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, ClinicConfig, countryCopy, INDUSTRIES, localDateOf, starterClinic, textingOf, zonedInstant } from '@attendra/core';
import {
  addClinicToOrganization, addMembership, assignNumber, clinicOwners, confirmEmail, createOrganizationWithClinic, type Database, type FrontDeskRepository,
  phoneUsage, qualityRows, releaseNumber, removeUnconfirmedAccount, resetTwoFactor, setTestCallLimit,
} from '@attendra/db';
import type { Logger } from '@attendra/observability';
import { Body, Controller, Delete, Get, Headers, HttpCode, HttpException, Inject, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Auth } from '../auth';
import { Public } from '../http/staff.guard';
import { API_OPTIONS, type ApiOptions, AUTH, CLOCK, DB, FRONT_DESK, LOGGER } from '../http/tokens';
import { ZodPipe } from '../http/zod.pipe';
import { createAccount, deleteNewAccount, findAccount } from '../members';
import { COST_PER_MINUTE } from '../overview/overview.controller';
import { qualityWeeks, weekStart } from '../quality/metrics';

/** How long an unconfirmed sign-up is kept before a new one may replace it: the hosting layer's link lifetime. */
const UNCONFIRMED_KEPT_MS = 48 * 3_600_000;

const NewAccount = z.object({
  organization: z.object({ name: z.string().trim().min(2).max(100) }),
  clinic: z.object({
    name: z.string().trim().min(2).max(100),
    timezone: z.string().min(1).max(64),
    industry: z.enum(INDUSTRIES),
    phone: z.string().regex(/^\+[1-9]\d{7,14}$/, 'expected E.164, like +13035550100'),
  }),
  owner: z.object({ name: z.string().trim().min(1).max(100), email: z.email().max(254), password: z.string().min(12).max(128) }),
  /** Total browser test-call time, for a trial; absent is no limit. */
  testCallMinutes: z.number().int().min(0).max(600).optional(),
  plan: z.string().trim().min(1).max(40).default('hosted'),
  /**
   * The address has an account whose email was never confirmed and the hosting layer has no
   * record of it (a sign-up it could not finish, or one made with someone else's address):
   * that account, with what it opened alone, is removed and this one opened instead, once it is
   * older than its confirmation link (48 hours).
   */
  replaceUnconfirmed: z.boolean().default(false),
});
const NewLocation = z.object({ clinic: NewAccount.shape.clinic, testCallMinutes: z.number().int().min(0).max(600).optional() });
const Email = z.object({ email: z.email().max(254) });
const Limit = z.object({ seconds: z.number().int().min(0).nullable() });
const TextingSwitch = z.object({ enabled: z.boolean() });
const EngineChoice = z.object({ engine: z.enum(['gpt-live', 'gpt-realtime']).nullable() });
const Period = z.object({ from: z.iso.datetime(), to: z.iso.datetime() }).refine((p) => p.from < p.to, 'from must be before to');
const ReportQuery = z.object({ weeks: z.coerce.number().int().min(1).max(8).default(1) });

const digest = (s: string) => createHash('sha256').update(s).digest();
const newId = (prefix: string) => `${prefix}_${randomBytes(8).toString('hex')}`;

/**
 * What a hosting layer (sign-up, billing, numbers) does to accounts, with a bearer token
 * shared between the two services: open an account, confirm its email, set its test-call
 * time, point numbers at it, read its minutes and its weekly numbers. None of it reads
 * patient data. Without ATTENDRA_PROVISIONING_TOKEN the routes answer 404.
 */
@ApiExcludeController()
@Public()
@Controller('provisioning')
export class ProvisioningController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(FRONT_DESK) private readonly desk: FrontDeskRepository,
    @Inject(API_OPTIONS) private readonly options: ApiOptions,
    @Inject(LOGGER) private readonly log: Logger,
    @Inject(CLOCK) private readonly now: () => Date,
  ) {}

  private check(authorization: string | undefined) {
    const token = this.options.provisioningToken;
    if (!token) throw new NotFoundException({ error: 'not_found' });
    if (typeof authorization !== 'string' || !timingSafeEqual(digest(authorization), digest(`Bearer ${token}`))) throw new HttpException({ error: 'unauthorized' }, 401);
  }

  /** A new organization, its clinic with the pack's first settings, and its owner, who signs in once the email is confirmed. */
  @Post('accounts')
  @HttpCode(201)
  async open(@Headers('authorization') authorization: string | undefined, @Body(new ZodPipe(NewAccount)) body: z.infer<typeof NewAccount>) {
    this.check(authorization);
    // checked first: nothing is replaced for a request that cannot open an account
    let config: ClinicConfig;
    try {
      config = starterClinic({ id: newId('clinic'), ...body.clinic });
    } catch {
      throw new HttpException({ error: 'invalid_request', issues: [{ path: 'clinic', message: 'unknown time zone or number' }] }, 422);
    }
    const taken = await findAccount(this.auth, body.owner.email);
    // an unconfirmed account is replaced only once its confirmation link has run out: before
    // then, its link could confirm whoever signed up second with the same address
    const replaced = !!taken && body.replaceUnconfirmed && !taken.emailVerified
      && (await removeUnconfirmedAccount(this.db, body.owner.email, { createdBefore: new Date(Date.now() - UNCONFIRMED_KEPT_MS) })) === 'removed';
    if (taken && !replaced) {
      // a confirmed account says so; one not confirmed yet says that too, so the hosting layer can send its link again
      throw new HttpException({ error: 'email_taken', confirmed: taken.emailVerified }, 409);
    }
    const organizationId = newId('org');
    const userId = await createAccount(this.auth, { ...body.owner, emailVerified: false });
    try {
      await createOrganizationWithClinic(this.db, { id: organizationId, name: body.organization.name, plan: body.plan }, config);
      await addMembership(this.db, organizationId, userId, 'owner');
      if (body.testCallMinutes !== undefined) await setTestCallLimit(this.db, config.id, body.testCallMinutes * 60);
    } catch (err) {
      await deleteNewAccount(this.auth, userId).catch(() => {});
      this.log.error({ name: (err as Error).name }, 'provisioning: account could not be opened');
      throw new HttpException({ error: 'not_opened' }, 500);
    }
    return { organizationId, clinicId: config.id, userId };
  }

  /** Another location in an organization: its own clinic, with the first one's assistant settings. Everyone in the organization sees it. */
  @Post('organizations/:organizationId/clinics')
  @HttpCode(201)
  async addLocation(@Headers('authorization') authorization: string | undefined, @Param('organizationId') organizationId: string, @Body(new ZodPipe(NewLocation)) body: z.infer<typeof NewLocation>) {
    this.check(authorization);
    let config: ClinicConfig;
    try {
      config = starterClinic({ id: newId('clinic'), ...body.clinic });
    } catch {
      throw new HttpException({ error: 'invalid_request', issues: [{ path: 'clinic', message: 'unknown time zone or number' }] }, 422);
    }
    const clinicId = await addClinicToOrganization(this.db, organizationId, config);
    if (!clinicId) throw new NotFoundException({ error: 'not_found' });
    if (body.testCallMinutes !== undefined) await setTestCallLimit(this.db, clinicId, body.testCallMinutes * 60);
    return { clinicId };
  }

  /**
   * A sign-up the hosting layer could not finish (its own record failed after the account
   * was opened): the account goes again, with what it opened alone, so the person can sign
   * up again. Only an account whose email was never confirmed and that has had no calls.
   */
  @Delete('accounts/unconfirmed')
  @HttpCode(204)
  async removeUnconfirmed(@Headers('authorization') authorization: string | undefined, @Body(new ZodPipe(Email)) body: z.infer<typeof Email>) {
    this.check(authorization);
    const result = await removeUnconfirmedAccount(this.db, body.email);
    if (result === 'not_found') throw new NotFoundException({ error: 'not_found' });
    if (result !== 'removed') throw new HttpException({ error: result }, 409);
  }

  /** Support, for someone who lost their phone and has nobody to reset two-step sign-in for them (a sole owner). Signs them out everywhere. */
  @Post('users/reset-two-factor')
  @HttpCode(204)
  async resetTwoFactor(@Headers('authorization') authorization: string | undefined, @Body(new ZodPipe(Email)) body: z.infer<typeof Email>) {
    this.check(authorization);
    const user = await findAccount(this.auth, body.email);
    if (!user) throw new NotFoundException({ error: 'not_found' });
    await resetTwoFactor(this.db, user.id);
    this.log.info({ user_id: user.id }, 'provisioning: two-step sign-in reset by support');
  }

  @Post('email-confirmations')
  @HttpCode(204)
  async confirm(@Headers('authorization') authorization: string | undefined, @Body(new ZodPipe(Email)) body: z.infer<typeof Email>) {
    this.check(authorization);
    if (!(await confirmEmail(this.db, body.email))) throw new NotFoundException({ error: 'not_found' });
  }

  @Put('clinics/:clinicId/test-call-limit')
  @HttpCode(204)
  async limit(@Headers('authorization') authorization: string | undefined, @Param('clinicId') clinicId: string, @Body(new ZodPipe(Limit)) body: z.infer<typeof Limit>) {
    this.check(authorization);
    if (!(await setTestCallLimit(this.db, clinicId, body.seconds))) throw new NotFoundException({ error: 'not_found' });
  }

  /** Texting during calls on or off: the hosting layer turns it on when the clinic's texting registration (A2P) is approved. */
  @Put('clinics/:clinicId/texting')
  @HttpCode(204)
  async texting(@Headers('authorization') authorization: string | undefined, @Param('clinicId') clinicId: string, @Body(new ZodPipe(TextingSwitch)) body: z.infer<typeof TextingSwitch>) {
    this.check(authorization);
    const done = await this.desk.updateSettings(clinicId, 'provisioning', 'clinic.texting.' + (body.enabled ? 'on' : 'off'), clinicId, (current) => {
      const c = ClinicConfig.parse(current);
      if ((c.texting?.enabled ?? false) === body.enabled) return { result: true };
      return { save: { ...c, texting: { ...textingOf(c), enabled: body.enabled } }, result: true };
    });
    if (!done) throw new NotFoundException({ error: 'not_found' });
  }

  /** Which voice engine answers this clinic's calls; null goes back to the deployment's default. Not something the clinic sets. */
  @Put('clinics/:clinicId/voice-engine')
  @HttpCode(204)
  async voiceEngine(@Headers('authorization') authorization: string | undefined, @Param('clinicId') clinicId: string, @Body(new ZodPipe(EngineChoice)) body: z.infer<typeof EngineChoice>) {
    this.check(authorization);
    const done = await this.desk.updateSettings(clinicId, 'provisioning', `clinic.voice_engine.${body.engine ?? 'default'}`, clinicId, (current) => {
      const c = ClinicConfig.parse(current);
      if ((c.voiceEngine ?? null) === body.engine) return { result: true };
      return { save: { ...c, voiceEngine: body.engine ?? undefined }, result: true };
    });
    if (!done) throw new NotFoundException({ error: 'not_found' });
  }

  @Put('clinics/:clinicId/numbers/:number')
  @HttpCode(204)
  async addNumber(@Headers('authorization') authorization: string | undefined, @Param('clinicId') clinicId: string, @Param('number') number: string) {
    this.check(authorization);
    if (!/^\+[1-9]\d{7,14}$/.test(number)) throw new HttpException({ error: 'invalid_request', issues: [{ path: 'number', message: 'expected E.164' }] }, 422);
    if (!(await assignNumber(this.db, clinicId, number))) throw new NotFoundException({ error: 'not_found' });
  }

  @Delete('numbers/:number')
  @HttpCode(204)
  async release(@Headers('authorization') authorization: string | undefined, @Param('number') number: string) {
    this.check(authorization);
    if (!(await releaseNumber(this.db, number))) throw new NotFoundException({ error: 'not_found' });
  }

  /** Phone calls in a period, start to end, for billing. */
  @Get('clinics/:clinicId/usage')
  async usage(@Headers('authorization') authorization: string | undefined, @Param('clinicId') clinicId: string, @Query(new ZodPipe(Period)) q: z.infer<typeof Period>) {
    this.check(authorization);
    if (!(await this.desk.settings(clinicId))) throw new NotFoundException({ error: 'not_found' });
    return phoneUsage(this.db, clinicId, new Date(q.from), new Date(q.to));
  }

  /** The weekly report's numbers: the Quality page's weeks, the owners to send it to, and the visit value. */
  @Get('clinics/:clinicId/report')
  async report(@Headers('authorization') authorization: string | undefined, @Param('clinicId') clinicId: string, @Query(new ZodPipe(ReportQuery)) q: z.infer<typeof ReportQuery>) {
    this.check(authorization);
    const stored = await this.desk.settings(clinicId);
    if (!stored) throw new NotFoundException({ error: 'not_found' });
    const clinic = ClinicConfig.parse(stored);
    const now = this.now();
    const first = addDays(weekStart(localDateOf(now, clinic.timezone)), -7 * q.weeks);
    const rows = await qualityRows(this.db, clinicId, zonedInstant(first, '00:00', clinic.timezone), now);
    // the weeks that have ended, newest first: a report on Monday is about last week
    const weeks = qualityWeeks(rows, clinic, now, q.weeks + 1, COST_PER_MINUTE).slice(1);
    return {
      clinic: { id: clinic.id, name: clinic.name, timezone: clinic.timezone, industry: clinic.industry, averageVisitValue: clinic.averageVisitValue, afterHours: clinic.afterHours, currency: countryCopy(clinic).currency },
      owners: (await clinicOwners(this.db, clinicId)).filter((o) => o.emailVerified).map(({ name, email }) => ({ name, email })),
      weeks,
    };
  }
}
