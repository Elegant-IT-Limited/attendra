// SPDX-License-Identifier: AGPL-3.0-only
import { avatarFor, type Database } from '@attendra/db';
import { Controller, Get, Headers, Inject, NotFoundException, Param, Res } from '@nestjs/common';
import { ApiCookieAuth, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { CurrentStaff, type Staff } from '../http/staff.guard';
import { DB } from '../http/tokens';

/**
 * People's pictures, for the dashboard's avatars. Served only to someone signed in who shares
 * an organization with the person; anyone else, and a person with no picture, gets 404. Kept
 * in this browser for five minutes (private, never in a shared cache): its address carries
 * its version, so a new picture shows at once.
 */
@ApiTags('me')
@ApiCookieAuth()
@Controller('users')
export class UsersController {
  constructor(@Inject(DB) private readonly db: Database) {}

  @Get(':userId/avatar')
  @ApiOperation({ summary: 'A teammate\'s picture (image/webp, image/png or image/jpeg). 404 unless you share an organization with them and they have one.' })
  @ApiParam({ name: 'userId' })
  @ApiOkResponse({ description: 'The image' })
  @ApiNotFoundResponse({ description: 'No picture, or not someone you work with' })
  async avatar(@Param('userId') userId: string, @Headers('if-none-match') ifNoneMatch: string | undefined, @CurrentStaff() staff: Staff, @Res() reply: FastifyReply) {
    const found = await avatarFor(this.db, staff.userId, userId);
    if (!found) throw new NotFoundException({ error: 'not_found' });
    const etag = `"a${found.updatedAt.getTime()}"`;
    reply.header('cache-control', 'private, max-age=300').header('etag', etag).header('x-content-type-options', 'nosniff');
    if (ifNoneMatch === etag) return reply.status(304).send();
    return reply.type(found.contentType).send(found.bytes);
  }
}
