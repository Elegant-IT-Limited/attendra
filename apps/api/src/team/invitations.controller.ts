// SPDX-License-Identifier: AGPL-3.0-only
import { answerInvitation, cancelInvitation, type Database, invitationsFor, orgOfClinic, teamInvitations } from '@attendra/db';
import { Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiCookieAuth, ApiForbiddenResponse, ApiNoContentResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { AcceptedInvitation, MyInvitationList, TeamInvitationList } from '../contracts';
import { schemaOf } from '../http/openapi';
import { CurrentStaff, Requires, type Staff } from '../http/staff.guard';
import { CLOCK, DB } from '../http/tokens';
import { REFUSED } from './team.controller';

/**
 * The invitations a team is waiting on (Team > Add people sends them), and cancelling one.
 * Like the rest of the team routes, for owners and managers in the dashboard: an API key
 * never manages people.
 */
@ApiTags('team')
@ApiCookieAuth()
@ApiParam({ name: 'clinicId', example: 'clinic_maple' })
@Controller('clinics/:clinicId/invitations')
export class TeamInvitationsController {
  constructor(@Inject(DB) private readonly db: Database, @Inject(CLOCK) private readonly now: () => Date) {}

  @Get()
  @Requires('members:manage')
  @ApiOperation({ summary: 'Invitations not answered yet: the email, the role, who sent it and when it lapses (7 days after it was sent)' })
  @ApiOkResponse({ schema: schemaOf(TeamInvitationList) })
  async list(@Param('clinicId') clinicId: string): Promise<TeamInvitationList> {
    const rows = await teamInvitations(this.db, await this.org(clinicId), this.now());
    return { invitations: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), expiresAt: r.expiresAt.toISOString() })) };
  }

  @Delete(':id')
  @HttpCode(204)
  @Requires('members:manage')
  @ApiOperation({ summary: 'Cancel an invitation not answered yet. Audited.' })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({ description: 'A manager cancelling an invitation to be an owner' })
  @ApiNotFoundResponse({ description: 'Not this team\'s, or already answered, cancelled or lapsed' })
  async cancel(@Param('clinicId') clinicId: string, @Param('id') id: string, @CurrentStaff() staff: Staff) {
    const result = await cancelInvitation(this.db, await this.org(clinicId), { userId: staff.userId, role: staff.role! }, id, this.now());
    if (result !== 'done') throw REFUSED[result]();
  }

  private async org(clinicId: string) {
    const orgId = await orgOfClinic(this.db, clinicId);
    if (!orgId) throw new NotFoundException({ error: 'not_found' });
    return orgId;
  }
}

/**
 * The signed-in person's own invitations, from any clinic, for the banner in the
 * dashboard. Accepting adds the clinic to their clinic switcher; their password, their
 * two-step sign-in and their other teams stay as they are.
 */
@ApiTags('me')
@ApiCookieAuth()
@Controller('me/invitations')
export class MyInvitationsController {
  constructor(@Inject(DB) private readonly db: Database, @Inject(CLOCK) private readonly now: () => Date) {}

  @Get()
  @ApiOperation({ summary: 'Invitations to join a clinic\'s team, waiting for your answer' })
  @ApiOkResponse({ schema: schemaOf(MyInvitationList) })
  async list(@CurrentStaff() staff: Staff): Promise<MyInvitationList> {
    const rows = await invitationsFor(this.db, staff.email, this.now());
    return { invitations: rows.map((r) => ({ ...r, expiresAt: r.expiresAt.toISOString() })) };
  }

  @Post(':id/accept')
  @HttpCode(200)
  @ApiOperation({ summary: 'Join the team with the role in the invitation. Audited in the inviting clinic.' })
  @ApiOkResponse({ schema: schemaOf(AcceptedInvitation) })
  @ApiNotFoundResponse({ description: 'Not an invitation to your email, or already answered, cancelled or lapsed' })
  async accept(@Param('id') id: string, @CurrentStaff() staff: Staff): Promise<AcceptedInvitation> {
    const answered = await answerInvitation(this.db, staff, id, true, this.now());
    if (answered.result !== 'done') throw new NotFoundException({ error: 'not_found', message: 'This invitation was cancelled or has lapsed. Ask the clinic to send a new one.' });
    return { clinicId: answered.clinicId };
  }

  @Post(':id/decline')
  @HttpCode(204)
  @ApiOperation({ summary: 'Say no to the invitation. Audited in the inviting clinic.' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: 'Not an invitation to your email, or already answered, cancelled or lapsed' })
  async decline(@Param('id') id: string, @CurrentStaff() staff: Staff) {
    if ((await answerInvitation(this.db, staff, id, false, this.now())).result !== 'done') throw new NotFoundException({ error: 'not_found' });
  }
}
