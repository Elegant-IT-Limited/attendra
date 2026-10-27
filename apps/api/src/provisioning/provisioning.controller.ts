// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, ClinicConfig, countryCopy, INDUSTRIES, localDateOf, openMinutes, starterClinic, textingOf, zonedInstant } from '@attendra/core';
import {
  addClinicToOrganization, addMembership, assignNumber, clinicOwners, confirmEmail, createOrganizationWithClinic, type Database, type FrontDeskRepository,
  openOrganizationForOwner, type PhiCipher, phoneCallsSince, phoneUsage, purgeClosedClinic, qualityRows, releaseNumber, removeUnconfirmedAccount, resetTwoFactor, schema, setClinicClosed, setHostingPlan, setTestCallLimit,
} from '@attendra/db';
import { eq } from 'drizzle-orm';
import type { Logger } from '@attendra/observability';
import { Body, type CanActivate, Controller, Delete, type ExecutionContext, Get, HttpCode, HttpException, Inject, Injectable, NotFoundException, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Auth } from '../auth';
import { Public } from '../http/staff.guard';
import { API_OPTIONS, type ApiOptions, AUTH, CIPHER, CLOCK, DB, FRONT_DESK, LOGGER } from '../http/tokens';
import { ZodPipe } from '../http/zod.pipe';
import { ClinicName, ClinicOverview, HostingPlan } from '../contracts';
import { createAccount, deleteNewAccount, findAccount } from '../members';
import { COST_PER_MINUTE } from '../overview/overview.controller';
import { qualityWeeks, weekStart } from '../quality/metrics';

/** How long an unconfirmed sign-up is kept before a new one may replace it: the hosting layer's link lifetime. */
const UNCONFIRMED_KEPT_MS = 48 * 3_600_000;

/** The city in a clinic's address, as the hosting layer shows it on a location's card: the last part that is not a postcode or a country of two letters. */
export function cityOf(address: string | undefined): string | null {
  const parts = (address ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  for (const part of parts.reverse()) {
    const words = part.replace(/\b[A-Z]{2}\b\s*\d{3,}.*$|\b\d{4,}.*$/g, '').trim();
    if (words && !/^[A-Z]{2}$/.test(words) && !/^\d/.test(words)) return words;
  }
  return null;
}

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
// an owner's second business: the same login, so no owner details; userId is the engine's, from /me
const ForUser = z.object({
  userId: z.string().min(1).max(100),
  organization: NewAccount.shape.organization,
  clinic: NewAccount.shape.clinic,
  testCallMinutes: NewAccount.shape.testCallMinutes,
  plan: NewAccount.shape.plan,
});
const NewLocation = z.object({ clinic: NewAccount.shape.clinic, testCallMinutes: z.number().int().min(0).max(600).optional() });
const Email = z.object({ email: z.email().max(254) });
const Limit = z.object({ seconds: z.number().int().min(0).nullable() });
const TextingSwitch = z.object({ enabled: z.boolean() });
const AnsweringSwitch = z.object({ paused: z.boolean() });
const PlanBody = z.object({ plan: HostingPlan.nullable() });
const Closed = z.object({ closed: z.boolean() });
const EngineChoice = z.object({ engine: z.enum(['gpt-live', 'gpt-realtime']).nullable() });
const Period = z.object({ from: z.iso.datetime(), to: z.iso.datetime() }).refine((p) => p.from < p.to, 'from must be before to');
const ReportQuery = z.object({ weeks: z.coerce.number().int().min(1).max(8).default(1) });
// a POST body, so a caller's number is never in an address: since when, and optionally the number a check call comes from
const CallsCheck = z.object({ since: z.iso.datetime(), from: z.string().regex(/^\+[1-9]\d{7,14}$/, 'expected E.164, like +13035550100').optional() });

const digest = (s: string) => createHash('sha256').update(s).digest();
const newId = (prefix: string) => `${prefix}_${randomBytes(8).toString('hex')}`;

/**
 * The shared token, checked before anything else, the body included: a request without it
 * is 401 whatever it carries (404 when the deployment has no token), never a 422 that would
 * say what a valid body looks like.
 */
@Injectable()
export class ProvisioningToken implements CanActivate {
  constructor(@Inject(API_OPTIONS) private readonly options: ApiOptions) {}

  canActivate(ctx: ExecutionContext): boolean {
    const token = this.options.provisioningToken;
    if (!token) throw new NotFoundException({ error: 'not_found' });
    const authorization = ctx.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>().headers.authorization;
    if (typeof authorization !== 'string' || !timingSafeEqual(digest(authorization), digest(`Bearer ${token}`))) throw new HttpException({ error: 'unauthorized' }, 401);
    return true;
  }
}

/**
 * What a hosting layer (sign-up, billing, numbers) does to accounts, with a bearer token
 * shared between the two services: open an account, confirm its email, set its test-call
 * time, point numbers at it, read its minutes and its weekly numbers. None of it reads
 * patient data. Without ATTENDRA_PROVISIONING_TOKEN the routes answer 404.
 */
@ApiExcludeController()
@Public()
@UseGuards(ProvisioningToken)
@Controller('provisioning')
export class ProvisioningController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(FRONT_DESK) private readonly desk: FrontDeskRepository,
    @Inject(LOGGER) private readonly log: Logger,
    @Inject(CLOCK) private readonly now: () => Date,
    @Inject(CIPHER) private readonly cipher: PhiCipher,
  ) {}

  /** A new organization, its clinic with the pack's first settings, and its owner, who signs in once the email is confirmed. */
  @Post('accounts')
  @HttpCode(201)
  async open(@Body(new ZodPipe(NewAccount)) body: z.infer<typeof NewAccount>) {
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

  /**
   * A separate business for someone who already owns a clinic, on the same login: a new
   * organization and clinic with its own plan, trial, setup and team, starting empty. 403
   * not_an_owner unless the login owns at least one organization (staff sign up with
   * another email); 409 not_confirmed for a login whose email was never confirmed.
   */
  @Post('accounts/for-user')
  @HttpCode(201)
  async openForOwner(@Body(new ZodPipe(ForUser)) body: z.infer<typeof ForUser>) {
    let config: ClinicConfig;
    try {
      config = starterClinic({ id: newId('clinic'), ...body.clinic });
    } catch {
      throw new HttpException({ error: 'invalid_request', issues: [{ path: 'clinic', message: 'unknown time zone or number' }] }, 422);
    }
    const organizationId = newId('org');
    const result = await openOrganizationForOwner(this.db, body.userId, { id: organizationId, name: body.organization.name, plan: body.plan }, config);
    if (result === 'not_found') throw new NotFoundException({ error: 'not_found' });
    if (result === 'not_confirmed') throw new HttpException({ error: 'not_confirmed' }, 409);
    if (result === 'not_an_owner') throw new HttpException({ error: 'not_an_owner' }, 403);
    if (body.testCallMinutes !== undefined) await setTestCallLimit(this.db, config.id, body.testCallMinutes * 60);
    this.log.info({ user_id: body.userId, organization_id: organizationId, clinic_id: config.id }, 'provisioning: an owner opened another organization');
    return { organizationId, clinicId: config.id, userId: body.userId };
  }

  /** Another location in an organization: its own clinic, with the first one's assistant settings. Everyone in the organization sees it. */
  @Post('organizations/:organizationId/clinics')
  @HttpCode(201)
  async addLocation(@Param('organizationId') organizationId: string, @Body(new ZodPipe(NewLocation)) body: z.infer<typeof NewLocation>) {
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
  async removeUnconfirmed(@Body(new ZodPipe(Email)) body: z.infer<typeof Email>) {
    const result = await removeUnconfirmedAccount(this.db, body.email);
    if (result === 'not_found') throw new NotFoundException({ error: 'not_found' });
    if (result !== 'removed') throw new HttpException({ error: result }, 409);
  }

  /** Support, for someone who lost their phone and has nobody to reset two-step sign-in for them (a sole owner). Signs them out everywhere. */
  @Post('users/reset-two-factor')
  @HttpCode(204)
  async resetTwoFactor(@Body(new ZodPipe(Email)) body: z.infer<typeof Email>) {
    const user = await findAccount(this.auth, body.email);
    if (!user) throw new NotFoundException({ error: 'not_found' });
    await resetTwoFactor(this.db, user.id);
    this.log.info({ user_id: user.id }, 'provisioning: two-step sign-in reset by support');
  }

  @Post('email-confirmations')
  @HttpCode(204)
  async confirm(@Body(new ZodPipe(Email)) body: z.infer<typeof Email>) {
    if (!(await confirmEmail(this.db, body.email))) throw new NotFoundException({ error: 'not_found' });
  }

  @Put('clinics/:clinicId/test-call-limit')
  @HttpCode(204)
  async limit(@Param('clinicId') clinicId: string, @Body(new ZodPipe(Limit)) body: z.infer<typeof Limit>) {
    if (!(await setTestCallLimit(this.db, clinicId, body.seconds))) throw new NotFoundException({ error: 'not_found' });
  }

  /** Texting during calls on or off: the hosting layer turns it on when the clinic's texting registration (A2P) is approved. */
  @Put('clinics/:clinicId/texting')
  @HttpCode(204)
  async texting(@Param('clinicId') clinicId: string, @Body(new ZodPipe(TextingSwitch)) body: z.infer<typeof TextingSwitch>) {
    const done = await this.desk.updateSettings(clinicId, 'provisioning', 'clinic.texting.' + (body.enabled ? 'on' : 'off'), clinicId, (current) => {
      const c = ClinicConfig.parse(current);
      if ((c.texting?.enabled ?? false) === body.enabled) return { result: true };
      return { save: { ...c, texting: { ...textingOf(c), enabled: body.enabled } }, result: true };
    });
    if (!done) throw new NotFoundException({ error: 'not_found' });
  }

  /**
   * The assistant paused or answering again: the hosting layer pauses it when a plan's free minutes are used up
   * or a payment is missing. Paused, calls go to the front desk while it takes transfers, or hear a short message.
   */
  @Put('clinics/:clinicId/answering')
  @HttpCode(204)
  async answering(@Param('clinicId') clinicId: string, @Body(new ZodPipe(AnsweringSwitch)) body: z.infer<typeof AnsweringSwitch>) {
    const done = await this.desk.updateSettings(clinicId, 'provisioning', 'clinic.answering.' + (body.paused ? 'paused' : 'resumed'), clinicId, (current) => {
      const c = ClinicConfig.parse(current);
      if ((c.answeringPaused ?? false) === body.paused) return { result: true };
      return { save: { ...c, answeringPaused: body.paused }, result: true };
    });
    if (!done) throw new NotFoundException({ error: 'not_found' });
  }

  /** The clinic's plan as the dashboard shows it (minutes, trial days); null clears it. Set on every change to the plan. */
  @Put('clinics/:clinicId/plan')
  @HttpCode(204)
  async plan(@Param('clinicId') clinicId: string, @Body(new ZodPipe(PlanBody)) body: z.infer<typeof PlanBody>) {
    if (!(await setHostingPlan(this.db, clinicId, body.plan))) throw new NotFoundException({ error: 'not_found' });
  }

  /** Closes a clinic (a location removed) or opens it again within 30 days. Nothing is deleted. */
  @Put('clinics/:clinicId/closed')
  @HttpCode(204)
  async closed(@Param('clinicId') clinicId: string, @Body(new ZodPipe(Closed)) body: z.infer<typeof Closed>) {
    if (!(await setClinicClosed(this.db, clinicId, body.closed, this.now()))) throw new NotFoundException({ error: 'not_found' });
    this.log.info({ clinic_id: clinicId, closed: body.closed }, 'provisioning: clinic closed or reopened');
  }

  /** Deletes a clinic closed at least 30 days ago, with everything recorded for it. 409 for an open clinic or one closed more recently. */
  @Delete('clinics/:clinicId')
  @HttpCode(204)
  async purge(@Param('clinicId') clinicId: string) {
    const result = await purgeClosedClinic(this.db, clinicId, this.now());
    if (result === 'not_found') throw new NotFoundException({ error: 'not_found' });
    if (result !== 'purged') throw new HttpException({ error: result === 'open' ? 'not_closed' : 'closed_recently' }, 409);
    this.log.info({ clinic_id: clinicId }, 'provisioning: closed clinic deleted');
  }

  /** Which voice engine answers this clinic's calls; null goes back to the deployment's default. Not something the clinic sets. */
  @Put('clinics/:clinicId/voice-engine')
  @HttpCode(204)
  async voiceEngine(@Param('clinicId') clinicId: string, @Body(new ZodPipe(EngineChoice)) body: z.infer<typeof EngineChoice>) {
    const done = await this.desk.updateSettings(clinicId, 'provisioning', `clinic.voice_engine.${body.engine ?? 'default'}`, clinicId, (current) => {
      const c = ClinicConfig.parse(current);
      if ((c.voiceEngine ?? null) === body.engine) return { result: true };
      return { save: { ...c, voiceEngine: body.engine ?? undefined }, result: true };
    });
    if (!done) throw new NotFoundException({ error: 'not_found' });
  }

  @Put('clinics/:clinicId/numbers/:number')
  @HttpCode(204)
  async addNumber(@Param('clinicId') clinicId: string, @Param('number') number: string) {
    if (!/^\+[1-9]\d{7,14}$/.test(number)) throw new HttpException({ error: 'invalid_request', issues: [{ path: 'number', message: 'expected E.164' }] }, 422);
    if (!(await assignNumber(this.db, clinicId, number))) throw new NotFoundException({ error: 'not_found' });
  }

  @Delete('numbers/:number')
  @HttpCode(204)
  async release(@Param('number') number: string) {
    if (!(await releaseNumber(this.db, number))) throw new NotFoundException({ error: 'not_found' });
  }

  /** A location at a glance for the hosting layer's Locations page: its number, city, today's calls and open requests. Counts only. */
  @Get('clinics/:clinicId/overview')
  async overview(@Param('clinicId') clinicId: string): Promise<ClinicOverview> {
    const stored = await this.desk.settings(clinicId);
    if (!stored) throw new NotFoundException({ error: 'not_found' });
    const clinic = ClinicConfig.parse(stored);
    const now = this.now();
    const dayStart = zonedInstant(localDateOf(now, clinic.timezone), '00:00', clinic.timezone);
    const [today, open] = await Promise.all([phoneCallsSince(this.db, this.cipher, clinicId, dayStart), this.desk.openTaskCount(clinicId)]);
    return { name: clinic.name, phoneNumber: clinic.phoneNumbers[0] ?? null, city: cityOf(clinic.address), callsToday: today.calls, openRequests: open };
  }

  /** Renames a location: the clinic's name on every screen and in the assistant's greeting line. Audited as clinic.renamed. */
  @Put('clinics/:clinicId/name')
  @HttpCode(204)
  async rename(@Param('clinicId') clinicId: string, @Body(new ZodPipe(ClinicName)) body: z.infer<typeof ClinicName>) {
    const done = await this.desk.updateSettings<true>(clinicId, 'provisioning', 'clinic.renamed', clinicId, async (stored, tx) => {
      const next = ClinicConfig.parse({ ...(stored as object), name: body.name });
      await tx.update(schema.clinics).set({ name: body.name }).where(eq(schema.clinics.id, clinicId));
      return { save: next, result: true };
    });
    if (!done) throw new NotFoundException({ error: 'not_found' });
  }

  /** Phone calls in a period, start to end, for billing. */
  @Get('clinics/:clinicId/usage')
  async usage(@Param('clinicId') clinicId: string, @Query(new ZodPipe(Period)) q: z.infer<typeof Period>) {
    if (!(await this.desk.settings(clinicId))) throw new NotFoundException({ error: 'not_found' });
    return phoneUsage(this.db, clinicId, new Date(q.from), new Date(q.to));
  }

  /**
   * Phone calls since a moment, for the hosting layer: how many, when the last began, whether
   * one came from `from` (the forwarding check: the owner calls the clinic's own number), and
   * the minutes the clinic was open since then (a line that stays quiet while open). No call details.
   */
  @Post('clinics/:clinicId/calls-check')
  @HttpCode(200)
  async callsCheck(@Param('clinicId') clinicId: string, @Body(new ZodPipe(CallsCheck)) body: z.infer<typeof CallsCheck>) {
    const stored = await this.desk.settings(clinicId);
    if (!stored) throw new NotFoundException({ error: 'not_found' });
    const since = new Date(body.since);
    const now = this.now();
    const calls = await phoneCallsSince(this.db, this.cipher, clinicId, since, body.from);
    return { ...calls, openMinutes: since < now ? openMinutes(ClinicConfig.parse(stored), since, now) : 0 };
  }

  /** The weekly report's numbers: the Quality page's weeks, the owners to send it to, and the visit value. */
  @Get('clinics/:clinicId/report')
  async report(@Param('clinicId') clinicId: string, @Query(new ZodPipe(ReportQuery)) q: z.infer<typeof ReportQuery>) {
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
