// SPDX-License-Identifier: AGPL-3.0-only
import { type Attempt, type Database, type Endpoint, type PhiCipher, WebhookRepository } from '@attendra/db';
import { deliver, eventId, type GuardOptions, newSecret, payloadOf, type Resolver, resolveEndpoint } from '@attendra/webhooks';
import { Body, Controller, Delete, Get, HttpCode, HttpException, Inject, NotFoundException, Param, Post, Put, UnprocessableEntityException } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { WebhookAttempt, WebhookAttempts, WebhookEndpoint, WebhookEndpointInput, WebhookEndpointPatch, WebhookEndpoints, WebhookSecret } from '../contracts';
import { schemaOf } from '../http/openapi';
import { CurrentStaff, Requires, type Staff } from '../http/staff.guard';
import { CIPHER, DB, WEBHOOK_GUARD } from '../http/tokens';
import { ZodPipe } from '../http/zod.pipe';

const isUuid = (s: string) => z.uuid().safeParse(s).success;
const SENDS_PER_MINUTE = 10;
const URL_PROBLEMS: Record<string, string> = {
  invalid_url: 'That is not a web address.',
  https_only: 'Use an https:// address.',
  credentials_in_url: 'Leave the user name and password out of the address.',
  private_address: 'That address is on a private network or this server. Use a public https address.',
  unresolvable: 'That name does not resolve. Check the address.',
};

/**
 * Settings > Integrations: where the clinic's events go (n8n, Zapier, Make, or its own
 * systems). Owners and managers only. A URL is checked when it is saved, and again,
 * after DNS, at every delivery. A secret is shown once, when it is made.
 */
@ApiTags('integrations')
@ApiCookieAuth()
@ApiParam({ name: 'clinicId', example: 'clinic_maple' })
@Controller('clinics/:clinicId/webhooks')
export class WebhooksController {
  /** Sends staff start (test events, redeliveries) per clinic in the last minute: each can hold a worker for up to 10 seconds. */
  private readonly sends = new Map<string, number[]>();

  private readonly repo: WebhookRepository;

  constructor(@Inject(DB) db: Database, @Inject(CIPHER) cipher: PhiCipher, @Inject(WEBHOOK_GUARD) private readonly guard: GuardOptions & { resolve?: Resolver }) {
    this.repo = new WebhookRepository(db, cipher);
  }

  @Get()
  @Requires('integrations:manage')
  @ApiOperation({ summary: 'The clinic\'s webhook endpoints, with their last delivery. No secrets.' })
  @ApiOkResponse({ schema: schemaOf(WebhookEndpoints) })
  async list(@Param('clinicId') clinicId: string): Promise<WebhookEndpoints> {
    return { endpoints: (await this.repo.list(clinicId)).map(view) };
  }

  @Post()
  @HttpCode(201)
  @Requires('integrations:manage')
  @ApiOperation({ summary: 'Add an endpoint. The response is the only time its secret is shown. Audited.' })
  @ApiBody({ schema: schemaOf(WebhookEndpointInput) })
  @ApiCreatedResponse({ schema: schemaOf(WebhookSecret) })
  async create(@Param('clinicId') clinicId: string, @Body(new ZodPipe(WebhookEndpointInput)) body: z.infer<typeof WebhookEndpointInput>, @CurrentStaff() staff: Staff): Promise<WebhookSecret> {
    await this.checkUrl(body.url);
    const secret = newSecret();
    const id = await this.repo.create(clinicId, { url: body.url, description: body.description, events: body.events, secret, userId: staff.userId, omitPatientIds: body.omitPatientIds });
    return { endpoint: view((await this.repo.get(clinicId, id))!), secret };
  }

  @Put(':endpointId')
  @Requires('integrations:manage')
  @ApiOperation({ summary: 'Change an endpoint, or turn it on or off. Turning it on clears its failures. Audited.' })
  @ApiBody({ schema: schemaOf(WebhookEndpointPatch) })
  @ApiOkResponse({ schema: schemaOf(WebhookEndpoint) })
  async update(@Param('clinicId') clinicId: string, @Param('endpointId') id: string, @Body(new ZodPipe(WebhookEndpointPatch)) body: z.infer<typeof WebhookEndpointPatch>, @CurrentStaff() staff: Staff) {
    if (body.url !== undefined) await this.checkUrl(body.url);
    if (!isUuid(id) || !(await this.repo.update(clinicId, id, body, staff.userId))) throw new NotFoundException({ error: 'not_found' });
    return view((await this.repo.get(clinicId, id))!);
  }

  @Delete(':endpointId')
  @HttpCode(204)
  @Requires('integrations:manage')
  @ApiOperation({ summary: 'Delete an endpoint and its delivery log. Audited.' })
  async remove(@Param('clinicId') clinicId: string, @Param('endpointId') id: string, @CurrentStaff() staff: Staff) {
    if (!isUuid(id) || !(await this.repo.remove(clinicId, id, staff.userId))) throw new NotFoundException({ error: 'not_found' });
  }

  @Post(':endpointId/rotate-secret')
  @Requires('integrations:manage')
  @ApiOperation({ summary: 'Make a new secret. The old one keeps signing too for 24 hours. Shown once. Audited.' })
  @ApiOkResponse({ schema: schemaOf(WebhookSecret) })
  async rotate(@Param('clinicId') clinicId: string, @Param('endpointId') id: string, @CurrentStaff() staff: Staff): Promise<WebhookSecret> {
    const secret = newSecret();
    if (!isUuid(id) || !(await this.repo.rotate(clinicId, id, secret, staff.userId))) throw new NotFoundException({ error: 'not_found' });
    return { endpoint: view((await this.repo.get(clinicId, id))!), secret };
  }

  /** Sends a webhook.test event now, and says what came back. Logged like any delivery. */
  @Post(':endpointId/test')
  @Requires('integrations:manage')
  @ApiOperation({ summary: 'Send a test event to the endpoint now, and see the response' })
  @ApiOkResponse({ schema: schemaOf(WebhookAttempt) })
  async test(@Param('clinicId') clinicId: string, @Param('endpointId') id: string) {
    // the endpoint must exist and be this clinic's before anything is recorded
    if (!isUuid(id) || !(await this.repo.get(clinicId, id))) throw new NotFoundException({ error: 'not_found' });
    const now = new Date();
    const event = { id: eventId('webhook.test', `${id}|${now.toISOString()}`), clinicId, type: 'webhook.test' as const, occurredAt: now.toISOString(), data: { endpointId: id, test: true } };
    this.throttle(clinicId);
    await this.repo.record(event);
    return this.send(clinicId, id, event.id, 'test');
  }

  @Get(':endpointId/attempts')
  @Requires('integrations:manage')
  @ApiOperation({ summary: 'The endpoint\'s last 50 delivery attempts, with status codes and timings' })
  @ApiOkResponse({ schema: schemaOf(WebhookAttempts) })
  async attempts(@Param('clinicId') clinicId: string, @Param('endpointId') id: string): Promise<WebhookAttempts> {
    if (!isUuid(id) || !(await this.repo.get(clinicId, id))) throw new NotFoundException({ error: 'not_found' });
    return { attempts: (await this.repo.attempts(clinicId, id)).map(attemptView) };
  }

  /** Sends an attempt's event again, now, to the same endpoint. */
  @Post(':endpointId/attempts/:attemptId/redeliver')
  @Requires('integrations:manage')
  @ApiOperation({ summary: 'Deliver an event again, now' })
  @ApiOkResponse({ schema: schemaOf(WebhookAttempt) })
  async redeliver(@Param('clinicId') clinicId: string, @Param('endpointId') id: string, @Param('attemptId') attemptId: string) {
    const previous = /^\d+$/.test(attemptId) ? await this.repo.attempt(clinicId, Number(attemptId)) : null;
    if (!previous || previous.endpointId !== id) throw new NotFoundException({ error: 'not_found' });
    this.throttle(clinicId);
    return this.send(clinicId, id, previous.eventId, 'redelivery');
  }

  /** At most SENDS_PER_MINUTE test events and redeliveries a minute, per clinic. */
  private throttle(clinicId: string, now = Date.now()) {
    const recent = (this.sends.get(clinicId) ?? []).filter((t) => t > now - 60_000);
    if (recent.length >= SENDS_PER_MINUTE) throw new HttpException({ error: 'rate_limited', message: 'Too many test events and redeliveries. Wait a minute.' }, 429);
    recent.push(now);
    this.sends.set(clinicId, recent);
  }

  private async send(clinicId: string, endpointId: string, evtId: string, kind: 'test' | 'redelivery') {
    const target = isUuid(endpointId) ? await this.repo.secrets(clinicId, endpointId) : null;
    const event = await this.repo.event(clinicId, evtId);
    if (!target || !event) throw new NotFoundException({ error: 'not_found' });
    const result = await deliver({ url: target.url, secrets: target.secrets }, { id: event.id, body: payloadOf({ ...event, type: event.type as never }, { omitPatientIds: target.omitPatientIds }) }, this.guard);
    const logged = await this.repo.logAttempt(clinicId, { endpointId, eventId: event.id, kind, attempt: 1, statusCode: result.status, durationMs: result.ms, error: result.error });
    if (result.ok) await this.repo.delivered(clinicId, endpointId);
    return attemptView((await this.repo.attempt(clinicId, logged))!);
  }

  private async checkUrl(url: string) {
    const checked = await resolveEndpoint(url, this.guard);
    if (!checked.ok) throw new UnprocessableEntityException({ error: 'invalid_request', issues: [{ path: 'url', message: URL_PROBLEMS[checked.problem] }], problem: checked.problem });
  }
}

const view = (e: Endpoint): WebhookEndpoint => ({
  id: e.id, url: e.url, description: e.description, events: e.events as WebhookEndpoint['events'], enabled: e.enabled, disabledReason: e.disabledReason,
  disabledAt: e.disabledAt?.toISOString() ?? null, consecutiveFailures: e.consecutiveFailures, createdAt: e.createdAt.toISOString(), rotating: e.rotating, omitPatientIds: e.omitPatientIds,
  lastAttempt: e.lastAttempt ? { at: e.lastAttempt.at.toISOString(), statusCode: e.lastAttempt.statusCode, error: e.lastAttempt.error } : null,
});
const attemptView = ({ endpointId: _e, ...a }: Attempt): WebhookAttempt => ({ ...a, at: a.at.toISOString() });

