// SPDX-License-Identifier: AGPL-3.0-only
import { type Database, type PhiCipher, qaExport } from '@attendra/db';
import { Controller, Get, HttpException, Inject, NotFoundException, Param, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { QaExport, QaExportQuery } from '../contracts';
import { schemaOf } from '../http/openapi';
import { apiKeyOf, KeyScope, Requires, type Staff } from '../http/staff.guard';
import { CIPHER, CLOCK, DB } from '../http/tokens';
import { ZodPipe } from '../http/zod.pipe';

/** Reads of the export per key (or per person) per hour: a daily export needs a handful; a loop is stopped. */
export const QA_EXPORT_LIMIT = { max: 30, windowMs: 3_600_000 };

/**
 * The QA read path (foundation A): one clinic day of calls, read-only, for quality review. Read with a clinic API key
 * that has qa:read (Settings > API keys), or by an owner or practice manager signed in. docs/qa-export.md.
 */
@ApiTags('qa')
@ApiCookieAuth()
@ApiBearerAuth()
@ApiParam({ name: 'clinicId', example: 'clinic_maple' })
@Controller('clinics/:clinicId/qa')
export class QaController {
  /** When each reader's recent reads were, for QA_EXPORT_LIMIT. In memory, like the API's own limit. */
  private readonly reads = new Map<string, number[]>();

  constructor(@Inject(DB) private readonly db: Database, @Inject(CIPHER) private readonly cipher: PhiCipher, @Inject(CLOCK) private readonly now: () => Date) {}

  /**
   * The day's calls (the clinic's own day; yesterday by default): each call's path, times, end reason, outcome, test-call
   * flag, the requests, bookings and texts it made (kinds and statuses, never a text's words), its event-log summary and
   * its transcript with numbers masked; and the day's numbers per call path. Read-only; every read is audited
   * (`qa.export`, with the key's id). 30 reads an hour per key.
   */
  @Get('export')
  @Requires('quality:read')
  @KeyScope('qa:read')
  @ApiOperation({ summary: 'One clinic day of calls for quality review: codes, times, masked transcripts and the day\'s numbers. Read-only, audited. A key with qa:read, or an owner or manager.' })
  @ApiQuery({ name: 'day', required: false, example: '2026-11-16', description: 'The clinic\'s own day, YYYY-MM-DD. Default: yesterday by the clinic\'s clock.' })
  @ApiOkResponse({ schema: schemaOf(QaExport) })
  async export(@Param('clinicId') clinicId: string, @Query(new ZodPipe(QaExportQuery)) q: z.infer<typeof QaExportQuery>, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<QaExport> {
    const key = apiKeyOf(req);
    const staff = (req as FastifyRequest & { staff?: Staff }).staff;
    const reader = key ? { keyId: key.keyId } : staff ? { userId: staff.userId } : null;
    if (!reader) throw new UnauthorizedException({ error: 'signed_out' });
    const wait = this.limited('keyId' in reader ? `key:${reader.keyId}` : `user:${reader.userId}`);
    if (wait) {
      void reply.header('retry-after', String(Math.ceil(wait / 1000)));
      throw new HttpException({ error: 'rate_limited', message: `At most ${QA_EXPORT_LIMIT.max} exports an hour.` }, 429);
    }
    const data = await qaExport(this.db, this.cipher, clinicId, q.day ?? null, reader, this.now());
    if (!data) throw new NotFoundException({ error: 'not_found' });
    return data;
  }

  /** Ms until the reader may read again, or 0 when they may now (and this read is counted). */
  private limited(who: string): number {
    const at = this.now().getTime();
    const recent = (this.reads.get(who) ?? []).filter((t) => at - t < QA_EXPORT_LIMIT.windowMs);
    if (recent.length >= QA_EXPORT_LIMIT.max) { this.reads.set(who, recent); return QA_EXPORT_LIMIT.windowMs - (at - recent[0]!); }
    recent.push(at);
    this.reads.set(who, recent);
    // the map never grows past the readers of the last hour
    if (this.reads.size > 1000) for (const [k, ts] of this.reads) if (!ts.some((t) => at - t < QA_EXPORT_LIMIT.windowMs)) this.reads.delete(k);
    return 0;
  }
}
