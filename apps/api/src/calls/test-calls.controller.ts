// SPDX-License-Identifier: AGPL-3.0-only
import type { Logger } from '@attendra/observability';
import { Body, Controller, HttpCode, HttpException, Inject, Param, Post } from '@nestjs/common';
import { ApiAcceptedResponse, ApiBody, ApiCookieAuth, ApiCreatedResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { TestCall, TestCallStart } from '../contracts';
import { schemaOf } from '../http/openapi';
import { CurrentStaff, Requires, type Staff } from '../http/staff.guard';
import { LOGGER, VOICE, type VoiceClient } from '../http/tokens';
import { ZodPipe } from '../http/zod.pipe';

@ApiTags('calls')
@ApiCookieAuth()
@ApiParam({ name: 'clinicId', example: 'clinic_maple' })
@Controller('clinics/:clinicId/test-calls')
export class TestCallsController {
  constructor(@Inject(VOICE) private readonly voice: VoiceClient | null, @Inject(LOGGER) private readonly log: Logger) {}

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
  @ApiOperation({ summary: 'Start a test call from the browser (WebRTC). Audited.' })
  @ApiBody({ schema: schemaOf(TestCallStart) })
  @ApiCreatedResponse({ schema: schemaOf(TestCall) })
  async start(@Param('clinicId') clinicId: string, @Body(new ZodPipe(TestCallStart)) body: z.infer<typeof TestCallStart>, @CurrentStaff() staff: Staff): Promise<TestCall> {
    const voice = this.available();
    try {
      return await voice.startTestCall(clinicId, staff.userId, body.sdp);
    } catch (err) {
      this.failed(clinicId, err, 'start');
    }
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
