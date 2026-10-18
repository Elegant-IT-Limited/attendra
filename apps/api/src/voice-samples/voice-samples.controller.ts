// SPDX-License-Identifier: AGPL-3.0-only
import { BUILT_IN_VOICES, ClinicConfig, hasPreview } from '@attendra/core';
import type { FrontDeskRepository } from '@attendra/db';
import { Controller, Get, HttpException, Inject, NotFoundException, Optional, Param, Query, Res, UnprocessableEntityException } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { Requires } from '../http/staff.guard';
import { FRONT_DESK, LOGGER, VOICE_SAMPLES, type VoiceSampler } from '../http/tokens';
import type { Logger } from '@attendra/observability';

const PER_CLINIC = 30; // samples per clinic in ten minutes: enough to try every voice, not to run up a bill
const WINDOW_MS = 10 * 60_000;
const CACHE = 100;

/**
 * A few seconds of a voice saying the clinic's own greeting, so whoever sets the
 * assistant up can hear it before choosing. The greeting names the clinic, never a
 * caller, so nothing here is patient data and nothing is written to the audit log.
 */
@ApiTags('settings')
@ApiCookieAuth()
@ApiParam({ name: 'clinicId', example: 'clinic_maple' })
@Controller('clinics/:clinicId/voice-sample')
export class VoiceSamplesController {
  private readonly cache = new Map<string, Buffer>();
  private readonly recent = new Map<string, number[]>();

  constructor(@Inject(FRONT_DESK) private readonly desk: FrontDeskRepository, @Inject(VOICE_SAMPLES) private readonly sampler: VoiceSampler | null, @Optional() @Inject(LOGGER) private readonly log?: Logger) {}

  @Get()
  @Requires('settings:read')
  @ApiOperation({ summary: 'The clinic\'s greeting, spoken in one of the built-in voices (audio/mpeg). Not audited: no patient data.' })
  async sample(@Param('clinicId') clinicId: string, @Query('voice') voice: string, @Res() reply: FastifyReply) {
    if (!(BUILT_IN_VOICES as readonly string[]).includes(voice)) throw new UnprocessableEntityException({ error: 'invalid_request', issues: [{ path: 'voice', message: 'not a built-in voice' }] });
    // checked before the rate limit and the model: nothing to make
    if (!hasPreview(voice)) throw new UnprocessableEntityException({ error: 'calls_only', message: 'This voice is only on calls, so it has no preview. Hear it in a test call.' });
    if (!this.sampler) throw new HttpException({ error: 'voice_samples_off', message: 'Voice samples are not switched on here. Try the voice in a test call.' }, 503);
    const stored = await this.desk.settings(clinicId);
    if (!stored) throw new NotFoundException({ error: 'not_found' });
    const text = ClinicConfig.parse(stored).greeting.slice(0, 300);
    const key = `${voice}\n${text}`;
    let audio = this.cache.get(key);
    if (!audio) {
      const now = Date.now();
      const times = (this.recent.get(clinicId) ?? []).filter((t) => now - t < WINDOW_MS);
      if (times.length >= PER_CLINIC) throw new HttpException({ error: 'rate_limited', message: 'That is a lot of samples. Try again in a few minutes.' }, 429);
      this.recent.set(clinicId, [...times, now]);
      try {
        audio = await this.sampler.sample(voice, text);
      } catch (err) {
        // the greeting is the clinic's, not a caller's: the reason is safe to log
        this.log?.warn({ clinic_id: clinicId, voice, err: { message: (err as Error).message } }, 'voice sample failed');
        throw new UnprocessableEntityException({ error: 'no_sample', message: 'This voice could not be sampled right now. Try again, or hear it in a test call.' });
      }
      if (this.cache.size >= CACHE) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, audio);
    }
    // never kept by the browser: the address is the same after the greeting changes, and the server keeps its own copy
    return reply.header('content-type', 'audio/mpeg').header('cache-control', 'no-store').send(audio);
  }
}
