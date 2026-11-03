// SPDX-License-Identifier: AGPL-3.0-only
import { asE164, ClinicConfig, isE164, PHONE_NUMBERS_ONLY } from '@attendra/core';
import type { Logger } from '@attendra/observability';
import { type Database, type FrontDeskRepository, type PatientRecords, testCallAllowance } from '@attendra/db';
import { Body, Controller, ForbiddenException, Get, HttpCode, HttpException, Inject, NotFoundException, Param, Post, UnprocessableEntityException } from '@nestjs/common';
import { ApiAcceptedResponse, ApiBody, ApiCookieAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { can } from '../access';
import { type CallAs, TestCall, TestCallAllowance, TestCallNumbers, TestCallNumbersQuery, TestCallStart } from '../contracts';
import { schemaOf } from '../http/openapi';
import { CurrentStaff, Requires, type Staff } from '../http/staff.guard';
import { CLOCK, DB, FRONT_DESK, LOGGER, PATIENTS, VOICE, type VoiceClient } from '../http/tokens';
import { ZodPipe } from '../http/zod.pipe';

/** Under this much test time left, a call would end before it said anything useful. */
const MIN_TEST_SECONDS = 15;

@ApiTags('calls')
@ApiCookieAuth()
@ApiParam({ name: 'clinicId', example: 'clinic_maple' })
@Controller('clinics/:clinicId/test-calls')
export class TestCallsController {
  constructor(@Inject(VOICE) private readonly voice: VoiceClient | null, @Inject(LOGGER) private readonly log: Logger, @Inject(DB) private readonly db: Database, @Inject(CLOCK) private readonly now: () => Date,
    @Inject(PATIENTS) private readonly records: PatientRecords, @Inject(FRONT_DESK) private readonly desk: FrontDeskRepository) {}

  /** A number from the records needs the records: a role that may not read patients may still type one. */
  private mayReadRecords(staff: Staff) {
    if (!staff.role || !can(staff.role, 'patients:read')) throw new ForbiddenException({ error: 'forbidden', message: `a ${staff.role ?? 'member'} cannot patients:read` });
  }

  /**
   * The number a test call is started as, as E.164, or null for no caller ID. A record's
   * number is read here, in this clinic only (another clinic's record is not found); a typed
   * one must read as a whole number. Only browser test calls come through here: a phone
   * call's caller ID is the carrier's, and nothing the API sends can change it.
   */
  private async callAs(clinicId: string, callAs: CallAs | undefined, staff: Staff): Promise<string | null> {
    if (!callAs || callAs.kind === 'none') return null;
    const stored = await this.desk.settings(clinicId);
    if (!stored) throw new NotFoundException({ error: 'not_found' });
    const clinic = ClinicConfig.parse(stored);
    if (callAs.kind === 'record') {
      this.mayReadRecords(staff);
      const phone = await this.records.phoneOf(clinicId, callAs.patientId, staff.userId);
      if (!phone) throw new NotFoundException({ error: 'not_found' });
      return asE164(clinic, phone);
    }
    const number = asE164(clinic, callAs.number);
    if (!isE164(number)) throw new UnprocessableEntityException({ error: 'invalid_request', issues: [{ path: 'callAs.number', message: PHONE_NUMBERS_ONLY }] });
    return number;
  }

  private available(): VoiceClient {
    if (!this.voice) throw new HttpException({ error: 'voice_not_configured' }, 503);
    return this.voice;
  }

  private failed(clinicId: string, err: unknown, action: 'start' | 'end'): never {
    const status = (err as { status?: number }).status;
    if (status === 429) throw new HttpException({ error: 'test_call_limit' }, 429);
    // on start, a 404 means the voice service is misconfigured (no internal token, wrong URL)
    if (status === 404 && action === 'end') throw new HttpException({ error: 'not_found' }, 404);
    this.log.warn({ clinic_id: clinicId, name: (err as Error).name, code: (err as { code?: string }).code }, 'test call request failed');
    throw new HttpException({ error: 'voice_unavailable' }, 502);
  }

  /**
   * Talks to the clinic's receptionist from the browser, with the live settings.
   * The browser sends its WebRTC offer and gets OpenAI's answer back; the audio then
   * flows between the browser and OpenAI, while the voice service runs the tools and
   * records the call like any other. The voice service audits the start together
   * with the call row, and allows two open test calls per clinic.
   */
  @Post()
  @HttpCode(201)
  @Requires('calls:test')
  @ApiOperation({ summary: 'Start a test call from the browser (WebRTC), with no caller ID or "as" a number from the records (needs patients:read) or typed. Audited.' })
  @ApiBody({ schema: schemaOf(TestCallStart) })
  @ApiCreatedResponse({ schema: schemaOf(TestCall) })
  async start(@Param('clinicId') clinicId: string, @Body(new ZodPipe(TestCallStart)) body: z.infer<typeof TestCallStart>, @CurrentStaff() staff: Staff): Promise<TestCall> {
    const voice = this.available();
    const callAs = await this.callAs(clinicId, body.callAs, staff);
    // a clinic with a test-call limit (a hosted trial) gets only the time it has left
    const { limitSeconds, usedSeconds } = await testCallAllowance(this.db, clinicId, this.now());
    const left = limitSeconds === null ? undefined : limitSeconds - usedSeconds;
    if (left !== undefined && left < MIN_TEST_SECONDS) throw new HttpException({ error: 'test_minutes_used' }, 403);
    try {
      const started = await voice.startTestCall(clinicId, staff.userId, body.sdp, left, callAs ? { callAs } : undefined);
      return { ...started, calledAsLast4: callAs ? callAs.replace(/\D/g, '').slice(-4) : null };
    } catch (err) {
      this.failed(clinicId, err, 'start');
    }
  }

  /**
   * The numbers on file a test call can be started as: one per household, "Jordan · …0123",
   * never the whole number, at most 20. A POST, not a GET: what is typed can be a name, and
   * URLs end up in logs. Audited like a patient search.
   */
  @Post('numbers')
  @HttpCode(200)
  @Requires('calls:test')
  @ApiOperation({ summary: 'Numbers from the records for "Call as": the owner\'s first name and the last four digits, one per household, at most 20. Needs patients:read too. Audited.' })
  @ApiBody({ schema: schemaOf(TestCallNumbersQuery) })
  @ApiOkResponse({ schema: schemaOf(TestCallNumbers) })
  async numbers(@Param('clinicId') clinicId: string, @Body(new ZodPipe(TestCallNumbersQuery)) body: z.infer<typeof TestCallNumbersQuery>, @CurrentStaff() staff: Staff): Promise<TestCallNumbers> {
    this.mayReadRecords(staff);
    return { numbers: await this.records.callAsNumbers(clinicId, body.q, staff.userId, this.now()) };
  }

  /** How much browser test-call time the clinic has, when it has a limit (hosted trials do). */
  @Get('allowance')
  @Requires('calls:test')
  @ApiOperation({ summary: 'The clinic\'s test-call time: its limit (null is none), the seconds used, the limit for one call, and how long the next call can last' })
  @ApiOkResponse({ schema: schemaOf(TestCallAllowance) })
  async allowance(@Param('clinicId') clinicId: string): Promise<TestCallAllowance> {
    const { limitSeconds, usedSeconds } = await testCallAllowance(this.db, clinicId, this.now());
    // the per-call limit belongs to the voice service; without it the page still renders, with no number
    let perCallSeconds: number | null = null;
    try {
      perCallSeconds = (await this.voice?.limits?.())?.maxSeconds ?? null;
    } catch (err) {
      this.log.warn({ clinic_id: clinicId, name: (err as Error).name, code: (err as { code?: string }).code }, 'test call limits unavailable');
    }
    const left = limitSeconds === null ? null : Math.max(0, limitSeconds - usedSeconds);
    const callSeconds = perCallSeconds === null ? null : left === null ? perCallSeconds : Math.min(perCallSeconds, left);
    return { limitSeconds, usedSeconds, perCallSeconds, callSeconds, minSeconds: MIN_TEST_SECONDS };
  }

  /**
   * Plays a scripted call through the real agent and database, with no audio and no
   * model, so the dashboard can show a live call. Only where the voice service was
   * started with simulated calls, which only the local demo does.
   */
  @Post('simulated')
  @HttpCode(201)
  @Requires('calls:test')
  @ApiOperation({ summary: 'Start a simulated live call (the local demo only). Audited as a test call.' })
  async simulated(@Param('clinicId') clinicId: string, @CurrentStaff() staff: Staff): Promise<{ callId: string }> {
    if (!this.voice?.simulatedCalls) throw new HttpException({ error: 'not_available' }, 404);
    try {
      return await this.voice.startSimulatedCall(clinicId, staff.userId);
    } catch (err) {
      this.failed(clinicId, err, 'start');
    }
  }

  /** Ends a test call whose page could not end it itself (closed while connecting). */
  @Post(':callId/end')
  @HttpCode(202)
  @Requires('calls:test')
  @ApiOperation({ summary: 'End a test call' })
  @ApiAcceptedResponse()
  async end(@Param('clinicId') clinicId: string, @Param('callId') callId: string): Promise<{ ending: true }> {
    const voice = this.available();
    try {
      await voice.endTestCall(clinicId, callId);
    } catch (err) {
      this.failed(clinicId, err, 'end');
    }
    return { ending: true };
  }
}
