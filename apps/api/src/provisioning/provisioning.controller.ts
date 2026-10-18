// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, ClinicConfig, countryCopy, INDUSTRIES, localDateOf, starterClinic, zonedInstant } from '@attendra/core';
import {
  addMembership, assignNumber, clinicOwners, confirmEmail, createOrganizationWithClinic, type Database, type FrontDeskRepository,
  phoneUsage, qualityRows, releaseNumber, setTestCallLimit,
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
});
const Email = z.object({ email: z.email().max(254) });
const Limit = z.object({ seconds: z.number().int().min(0).nullable() });
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
    if (await findAccount(this.auth, body.owner.email)) throw new HttpException({ error: 'email_taken' }, 409);
    let config: ClinicConfig;
    try {
      config = starterClinic({ id: newId('clinic'), ...body.clinic });
    } catch {
      throw new HttpException({ error: 'invalid_request', issues: [{ path: 'clinic', message: 'unknown time zone or number' }] }, 422);
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
