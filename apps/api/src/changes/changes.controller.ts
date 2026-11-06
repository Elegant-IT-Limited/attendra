// SPDX-License-Identifier: AGPL-3.0-only
import { type ChangeFeed, type ChangeScope, type ChangeTopic, type Database, staffRole } from '@attendra/db';
import { Controller, Get, Inject, NotFoundException, Param, Req, Res } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiParam, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Auth } from '../auth';
import { CurrentStaff, Requires, type Staff, toHeaders } from '../http/staff.guard';
import { AUTH, CHANGES, DB } from '../http/tokens';

/** How long the stream waits to gather notices into one message: a booking writes several rows. */
const GATHER_MS = 250;
/** Under Cloudflare's 100 s idle limit and any proxy's, with room to spare. */
export const HEARTBEAT_MS = 15_000;
/** How long one stream lasts before the browser quietly comes back through the sign-in check. */
export const STREAM_CAP_MS = 60 * 60_000;
const RECHECK_MS = 5 * 60_000;

/**
 * What changed, as Server-Sent Events, so every screen updates without a refresh: a
 * request the assistant took, a booking, a new patient, a call that ended, a doctor
 * added, a call going on now, and the person's own invitations and roles. Each message
 * names only the kinds of thing that changed; the browser then reads the page again
 * through its usual route, which checks the role and writes the audit row.
 *
 * Every message has an id. A browser that comes back (a dropped connection, the
 * 60-minute end, a restart of the API) sends the last one, and its first message, the
 * `ready` event, says what it missed: some kinds of thing, or `*` (everything, when the
 * gap cannot be told), or nothing. So a reconnect replays what was missed and no more.
 */
@ApiTags('changes')
@ApiCookieAuth()
@Controller()
export class ChangesController {
  constructor(@Inject(CHANGES) private readonly feed: ChangeFeed | null, @Inject(AUTH) private readonly auth: Auth, @Inject(DB) private readonly db: Database) {}

  @Get('clinics/:clinicId/changes')
  @Requires('calls:list')
  @ApiParam({ name: 'clinicId', example: 'clinic_maple' })
  @ApiOperation({ summary: 'Which kinds of thing changed in this clinic, and for the person asking, as they change (text/event-stream). No patient data.' })
  @ApiProduces('text/event-stream')
  clinic(@Param('clinicId') clinicId: string, @CurrentStaff() staff: Staff, @Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    this.stream({ clinicId, userId: staff.userId }, staff, req, reply);
  }

  /** The same for a page outside any clinic (the start page, the profile): the person's own invitations and roles only. */
  @Get('me/changes')
  @ApiOperation({ summary: 'Whether the signed-in person\'s invitations or roles changed, as they change (text/event-stream).' })
  @ApiProduces('text/event-stream')
  me(@CurrentStaff() staff: Staff, @Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    this.stream({ userId: staff.userId }, staff, req, reply);
  }

  private stream(scope: ChangeScope, staff: Staff, req: FastifyRequest, reply: FastifyReply) {
    const feed = this.feed;
    if (!feed) throw new NotFoundException({ error: 'not_available' });
    const last = req.headers['last-event-id'];
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    // what was missed, the id to come back with, and the subscription, in one turn: nothing slips between them
    const missed = feed.since(scope, typeof last === 'string' ? last : null);
    res.write(`retry: 3000\n\nid: ${feed.cursor()}\nevent: ready\ndata: ${JSON.stringify({ missed: missed ?? [] })}\n\n`);
    const pending = new Set<ChangeTopic | '*'>();
    let newest = 0;
    let timer: NodeJS.Timeout | null = null;
    const flush = () => {
      timer = null;
      const topics = pending.has('*') ? ['*'] : [...pending];
      res.write(`id: ${feed.cursor(newest)}\nevent: change\ndata: ${JSON.stringify({ topics })}\n\n`);
      pending.clear();
    };
    const unsubscribe = feed.subscribe(scope, (n) => { pending.add(n.topic); newest = Math.max(newest, n.seq); timer ??= setTimeout(flush, GATHER_MS); });
    const headers = toHeaders(req.headers);
    const beat = setInterval(() => res.write(': still here\n\n'), HEARTBEAT_MS);
    // every 5 minutes: still signed in, and on a clinic's stream still on its team
    const recheck = setInterval(() => {
      void (async () => {
        const session = await this.auth.api.getSession({ headers }).catch(() => null);
        if (session?.user.id !== staff.userId || (scope.clinicId && !(await staffRole(this.db, staff.userId, scope.clinicId)))) res.end();
      })();
    }, RECHECK_MS);
    const cap = setTimeout(() => res.end(), STREAM_CAP_MS);
    res.on('close', () => { unsubscribe(); if (timer) clearTimeout(timer); clearInterval(beat); clearInterval(recheck); clearTimeout(cap); });
  }
}
