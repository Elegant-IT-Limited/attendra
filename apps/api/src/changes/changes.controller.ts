// SPDX-License-Identifier: AGPL-3.0-only
import { type ChangeFeed, type ChangeTopic, type Database, staffRole } from '@attendra/db';
import { Controller, Get, Inject, NotFoundException, Param, Req, Res } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiParam, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Auth } from '../auth';
import { CurrentStaff, Requires, type Staff, toHeaders } from '../http/staff.guard';
import { AUTH, CHANGES, DB } from '../http/tokens';

/** How long the stream waits to gather notices into one message: a booking writes several rows. */
const GATHER_MS = 250;
const HEARTBEAT_MS = 15_000;

/**
 * What changed in the clinic, as Server-Sent Events, so every screen updates without a
 * refresh: a request the assistant took, a booking, a new patient, a call that ended,
 * a doctor added. Each message names only the kinds of thing that changed; the browser
 * then reads the page again through its usual route, which checks the role and writes
 * the audit row. A stream ends after 60 minutes, or when the person is no longer signed
 * in to this clinic, and the browser reconnects.
 */
@ApiTags('changes')
@ApiCookieAuth()
@ApiParam({ name: 'clinicId', example: 'clinic_maple' })
@Controller('clinics/:clinicId/changes')
export class ChangesController {
  constructor(@Inject(CHANGES) private readonly feed: ChangeFeed | null, @Inject(AUTH) private readonly auth: Auth, @Inject(DB) private readonly db: Database) {}

  @Get()
  @Requires('calls:list')
  @ApiOperation({ summary: 'Which kinds of thing changed in this clinic, as they change (text/event-stream). No patient data.' })
  @ApiProduces('text/event-stream')
  stream(@Param('clinicId') clinicId: string, @CurrentStaff() staff: Staff, @Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const feed = this.feed;
    if (!feed) throw new NotFoundException({ error: 'not_available' });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 3000\n\n');
    const pending = new Set<ChangeTopic>();
    let timer: NodeJS.Timeout | null = null;
    const flush = () => { timer = null; res.write(`event: change\ndata: ${JSON.stringify({ topics: [...pending] })}\n\n`); pending.clear(); };
    const unsubscribe = feed.subscribe(clinicId, (topic) => { pending.add(topic); timer ??= setTimeout(flush, GATHER_MS); });
    const headers = toHeaders(req.headers);
    const beat = setInterval(() => res.write(': still here\n\n'), HEARTBEAT_MS);
    // every 5 minutes: still signed in, still on this clinic's team
    const recheck = setInterval(() => {
      void (async () => {
        const session = await this.auth.api.getSession({ headers }).catch(() => null);
        if (session?.user.id !== staff.userId || !(await staffRole(this.db, staff.userId, clinicId))) res.end();
      })();
    }, 5 * 60_000);
    const cap = setTimeout(() => res.end(), 60 * 60_000);
    res.on('close', () => { unsubscribe(); if (timer) clearTimeout(timer); clearInterval(beat); clearInterval(recheck); clearTimeout(cap); });
  }
}
