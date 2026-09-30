// SPDX-License-Identifier: AGPL-3.0-only
import { type Database, type FrontDeskRepository, setTransferNumber, staffNames, staffRole, transferNumber } from '@attendra/db';
import { callingCode, ClinicConfig, inClinicCountry, lastFour } from '@attendra/core';
import type { Logger } from '@attendra/observability';
import { Body, Controller, Get, HttpCode, HttpException, Inject, NotFoundException, Param, Post, Put, Req, Res, UnprocessableEntityException } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOkResponse, ApiOperation, ApiParam, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can } from '../access';
import { LiveCalls, LiveCoach, LiveEnd, LiveTakeOver, TransferNumber } from '../contracts';
import { schemaOf } from '../http/openapi';
import type { Auth } from '../auth';
import { CurrentStaff, Requires, type Staff, toHeaders } from '../http/staff.guard';
import { API_OPTIONS, type ApiOptions, AUTH, DB, FRONT_DESK, LOGGER, type LiveActionResult, VOICE, type VoiceClient } from '../http/tokens';
import { ZodPipe } from '../http/zod.pipe';

const isUuid = (s: string) => z.uuid().safeParse(s).success;

/**
 * Live calls. The voice service keeps the calls it is running and their events; this
 * controller checks who is asking, audits what they see and do, and passes the rest
 * through. Captions are patient data, so the stream needs `calls:read`; the list
 * without names is for everyone who may list calls.
 */
@ApiTags('live')
@ApiCookieAuth()
@ApiParam({ name: 'clinicId', example: 'clinic_maple' })
@Controller('clinics/:clinicId')
export class LiveController {
  constructor(
    @Inject(VOICE) private readonly voice: VoiceClient | null, @Inject(FRONT_DESK) private readonly desk: FrontDeskRepository,
    @Inject(DB) private readonly db: Database, @Inject(LOGGER) private readonly log: Logger,
    @Inject(AUTH) private readonly auth: Auth, @Inject(API_OPTIONS) private readonly options: ApiOptions,
  ) {}

  @Get('live')
  @Requires('calls:list')
  @ApiOperation({ summary: 'The calls going on now: duration, what the assistant is doing, whether it waits for a yes, emergencies. The verified caller\'s short name only for roles that may read calls, and that view is audited.' })
  @ApiOkResponse({ schema: schemaOf(LiveCalls) })
  async list(@Param('clinicId') clinicId: string, @CurrentStaff() staff: Staff): Promise<LiveCalls> {
    const calls = this.voice ? await this.voice.liveCalls(clinicId).catch((err: unknown) => {
      this.log.warn({ clinic_id: clinicId, code: (err as { code?: string }).code }, 'live calls unavailable');
      return [];
    }) : [];
    const names = !!staff.role && can(staff.role, 'calls:read');
    if (names) await this.desk.recordLiveList(clinicId, staff.userId, calls.filter((c) => c.verified).map((c) => c.callId));
    return {
      calls: calls.map((c) => ({
        callId: c.callId, channel: c.channel, startedAt: c.startedAt, verified: !!c.verified, caller: names ? c.verified : null,
        doing: c.doing, waitingForYes: c.waitingForYes, emergency: c.emergency,
      })),
      counts: { live: calls.length, emergencies: calls.filter((c) => c.emergency).length },
    };
  }

  /**
   * The live call as Server-Sent Events: captions, tool steps, the verified caller,
   * the read-back waiting for a yes, an emergency, staff actions, and the end. The
   * browser reconnects with Last-Event-ID and misses nothing; heartbeats every 15
   * seconds keep proxies from closing it. A stream ends when the call does, or after
   * 60 minutes (the browser then reconnects through the sign-in check), and every 5
   * minutes it checks that the watcher is still signed in and may still read calls.
   */
  @Get('calls/:callId/live')
  @Requires('calls:read')
  @ApiOperation({ summary: 'One live call\'s events (text/event-stream). Audited once per person and call per five minutes.' })
  @ApiProduces('text/event-stream')
  async stream(@Param('clinicId') clinicId: string, @Param('callId') callId: string, @CurrentStaff() staff: Staff, @Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const voice = this.voice;
    const last = typeof req.headers['last-event-id'] === 'string' ? req.headers['last-event-id'] : null;
    if (!voice || !isUuid(callId) || !(await this.desk.watchLive(clinicId, callId, staff.userId, false))) throw new NotFoundException({ error: 'not_found' });
    const abort = new AbortController();
    const body = await voice.liveStream(clinicId, callId, last, abort.signal).catch(() => null);
    if (!body) throw new NotFoundException({ error: 'not_live' });
    // audited on the server's terms: a Last-Event-ID from the client never skips it
    await this.desk.watchLive(clinicId, callId, staff.userId, true);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.on('close', () => abort.abort());
    const reader = body.getReader();
    const limits = { maxMs: 60 * 60_000, recheckMs: 5 * 60_000, ...this.options.liveStream };
    const headers = toHeaders(req.headers);
    const stillAllowed = async () => {
      const session = await this.auth.api.getSession({ headers }).catch(() => null);
      if (session?.user.id !== staff.userId) return false;
      const role = await staffRole(this.db, staff.userId, clinicId);
      return !!role && can(role, 'calls:read');
    };
    const cap = setTimeout(() => abort.abort(), limits.maxMs);
    const recheck = setInterval(() => { void stillAllowed().then((ok) => { if (!ok) abort.abort(); }); }, limits.recheckMs);
    abort.signal.addEventListener('abort', () => { clearTimeout(cap); clearInterval(recheck); void reader.cancel().catch(() => {}); }, { once: true });
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } catch {
      // the watcher left, or the voice service went away; either way the stream is over
    } finally {
      clearTimeout(cap);
      clearInterval(recheck);
      res.end();
    }
  }

  @Post('calls/:callId/live/coach')
  @HttpCode(202)
  @Requires('calls:coach')
  @ApiOperation({ summary: 'Send the assistant a short note on a live call. It never overrides the rules. Audited with the note\'s length, never its words.' })
  @ApiBody({ schema: schemaOf(LiveCoach) })
  async coach(@Param('clinicId') clinicId: string, @Param('callId') callId: string, @Body(new ZodPipe(LiveCoach)) body: z.infer<typeof LiveCoach>, @CurrentStaff() staff: Staff) {
    return this.act(clinicId, callId, staff, 'call.coached', { characters: body.note.length }, () => this.live().coach(clinicId, callId, { userId: staff.userId, key: body.key, note: body.note }));
  }

  @Post('calls/:callId/live/take-over')
  @HttpCode(202)
  @Requires('calls:coach')
  @ApiOperation({ summary: 'Take a live phone call: the assistant says a person is coming on, then transfers to the front desk or your own number. Audited.' })
  @ApiBody({ schema: schemaOf(LiveTakeOver) })
  async takeOver(@Param('clinicId') clinicId: string, @Param('callId') callId: string, @Body(new ZodPipe(LiveTakeOver)) body: z.infer<typeof LiveTakeOver>, @CurrentStaff() staff: Staff) {
    let target: { kind: 'front_desk' } | { kind: 'number'; number: string } = { kind: 'front_desk' };
    let destination: string | null;
    if (body.target === 'me') {
      const number = await transferNumber(this.db, staff.userId, clinicId);
      if (!number) throw new HttpException({ error: 'no_number' }, 409);
      target = { kind: 'number', number };
      destination = number;
    } else {
      const clinic = ClinicConfig.parse(await this.desk.settings(clinicId));
      destination = clinic.routing.find((r) => r.target === 'front_desk')?.uri ?? null;
    }
    // the audit row names the destination by its last four digits only
    return this.act(clinicId, callId, staff, 'call.taken_over', {
      ownNumber: target.kind === 'number' ? 1 : 0, ...(destination ? { destinationLast4: Number(lastFour(destination)) } : {}),
    }, () => this.live().takeOver(clinicId, callId, { userId: staff.userId, key: body.key, target }));
  }

  @Post('calls/:callId/live/end')
  @HttpCode(202)
  @Requires('calls:coach')
  @ApiOperation({ summary: 'End a live call: the assistant says goodbye, then hangs up. Audited.' })
  @ApiBody({ schema: schemaOf(LiveEnd) })
  async end(@Param('clinicId') clinicId: string, @Param('callId') callId: string, @Body(new ZodPipe(LiveEnd)) body: z.infer<typeof LiveEnd>, @CurrentStaff() staff: Staff) {
    return this.act(clinicId, callId, staff, 'call.ended_by_staff', undefined, () => this.live().endCall(clinicId, callId, { userId: staff.userId, key: body.key }));
  }

  @Get('my-transfer-number')
  @Requires('calls:coach')
  @ApiOperation({ summary: 'Your own number for taking over live calls at this practice, if you gave one' })
  @ApiOkResponse({ schema: schemaOf(TransferNumber) })
  async myNumber(@Param('clinicId') clinicId: string, @CurrentStaff() staff: Staff) {
    return { number: await transferNumber(this.db, staff.userId, clinicId) };
  }

  @Put('my-transfer-number')
  @Requires('calls:coach')
  @ApiOperation({ summary: 'Set or clear your own number for taking over live calls' })
  @ApiBody({ schema: schemaOf(TransferNumber) })
  async setMyNumber(@Param('clinicId') clinicId: string, @Body(new ZodPipe(TransferNumber)) body: z.infer<typeof TransferNumber>, @CurrentStaff() staff: Staff) {
    // a take-over rings this number, so it must be in the clinic's own country
    const clinic = ClinicConfig.parse(await this.desk.settings(clinicId));
    if (body.number && !inClinicCountry(clinic, body.number)) {
      throw new UnprocessableEntityException({ error: 'invalid_request', issues: [{ path: 'number', message: `use a number in the clinic's country (+${callingCode(clinic.phoneNumbers[0] ?? '') ?? '?'})` }] });
    }
    if (!(await setTransferNumber(this.db, staff.userId, clinicId, body.number))) throw new NotFoundException({ error: 'not_found' });
    return { number: body.number };
  }

  private live(): VoiceClient {
    if (!this.voice) throw new NotFoundException({ error: 'not_live' });
    return this.voice;
  }

  /**
   * Runs a staff action with its audit row written first; the row stays only when the
   * action happened, the first time. Names who got there first when someone else did.
   */
  private async act(clinicId: string, callId: string, staff: Staff, action: 'call.coached' | 'call.taken_over' | 'call.ended_by_staff', counts: Record<string, number> | undefined, run: () => Promise<LiveActionResult>) {
    const r = isUuid(callId) ? await this.desk.auditedLiveAction(clinicId, callId, staff.userId, action, counts, run, (x) => x.ok && !x.repeat) : await run();
    if (r.ok) return { ok: true };
    if (r.error === 'already_taken') {
      const by = r.by ? (await staffNames(this.db, clinicId, [r.by])).get(r.by) ?? null : null;
      throw new HttpException({ error: 'already_taken', by }, 409);
    }
    if (r.status === 404) throw new NotFoundException({ error: 'not_live' });
    if (r.status === 409) throw new HttpException({ error: r.error }, 409);
    this.log.warn({ clinic_id: clinicId, code: r.error }, 'live action failed');
    throw new HttpException({ error: 'voice_unavailable' }, 502);
  }
}
