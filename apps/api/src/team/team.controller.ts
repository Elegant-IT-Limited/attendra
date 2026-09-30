// SPDX-License-Identifier: AGPL-3.0-only
import { changeTeam, type Database, listMembers, orgOfClinic, type TeamChange, type TeamResult, TEMPORARY_PASSWORD_HOURS } from '@attendra/db';
import { Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { ApiBody, ApiConflictResponse, ApiCookieAuth, ApiCreatedResponse, ApiForbiddenResponse, ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import type { Auth } from '../auth';
import { AddedMember, AddMember, ChangeRole, MemberList } from '../contracts';
import { schemaOf } from '../http/openapi';
import { CurrentStaff, Requires, type Staff } from '../http/staff.guard';
import { AUTH, CLOCK, DB } from '../http/tokens';
import { ZodPipe } from '../http/zod.pipe';
import { createAccount, deleteNewAccount, findAccount, hashPassword, temporaryPassword } from '../members';

const REFUSED: Record<Exclude<TeamResult, 'done' | 'unchanged'>, () => Error> = {
  not_found: () => new NotFoundException({ error: 'not_found' }),
  already_member: () => new ConflictException({ error: 'already_member', message: 'This person is already on the team. Change their role instead.' }),
  self: () => new ForbiddenException({ error: 'forbidden', message: 'You cannot do that to your own account here. Ask another owner or manager.' }),
  owner_protected: () => new ForbiddenException({ error: 'forbidden', message: 'Only an owner can change, reset or remove an owner.' }),
  owner_grant: () => new ForbiddenException({ error: 'forbidden', message: 'Only an owner can make someone an owner.' }),
  last_owner: () => new ConflictException({ error: 'last_owner', message: 'This is the last owner. Make someone else an owner first.' }),
};

/**
 * The people who can sign in to this clinic's organization. Owners and managers
 * add, change, reset and remove them. Each change and its audit rows happen in one
 * transaction with the team locked (changeTeam), so the rules hold under races: a
 * manager cannot touch an owner or make one, nobody changes, resets or removes
 * themselves here, and the last owner stays.
 *
 * A new person gets a temporary password, shown once. It must be changed at first
 * sign-in and expires after 72 hours, so the manager who read it out never holds a
 * working password for someone else. An email that already has an Attendra account
 * is refused rather than added silently: invitations come later.
 */
@ApiTags('team')
@ApiCookieAuth()
@ApiParam({ name: 'clinicId', example: 'clinic_maple' })
@Controller('clinics/:clinicId/members')
export class TeamController {
  constructor(@Inject(DB) private readonly db: Database, @Inject(AUTH) private readonly auth: Auth, @Inject(CLOCK) private readonly now: () => Date) {}

  @Get()
  @Requires('members:manage')
  @ApiOperation({ summary: 'Everyone in the clinic\'s organization, with their role and two-step sign-in' })
  @ApiOkResponse({ schema: schemaOf(MemberList) })
  async list(@Param('clinicId') clinicId: string, @CurrentStaff() staff: Staff): Promise<MemberList> {
    const members = await listMembers(this.db, await this.org(clinicId));
    return { members: members.map((m) => ({ ...m, you: m.userId === staff.userId, addedAt: m.addedAt.toISOString() })) };
  }

  @Post()
  @HttpCode(201)
  @Requires('members:manage')
  @ApiOperation({ summary: 'Add a person with a role. Returns a temporary password once: it must be changed at first sign-in and expires after 72 hours. Audited.' })
  @ApiBody({ schema: schemaOf(AddMember) })
  @ApiCreatedResponse({ schema: schemaOf(AddedMember) })
  @ApiConflictResponse({ description: 'Already on the team (already_member), or already has an Attendra account with another practice (account_exists)' })
  async add(@Param('clinicId') clinicId: string, @Body(new ZodPipe(AddMember)) body: z.infer<typeof AddMember>, @CurrentStaff() staff: Staff): Promise<AddedMember> {
    const orgId = await this.org(clinicId);
    if (body.role === 'owner' && staff.role !== 'owner') throw REFUSED.owner_grant();
    const existing = await findAccount(this.auth, body.email);
    if (existing) {
      if ((await listMembers(this.db, orgId)).some((m) => m.userId === existing.id)) throw REFUSED.already_member();
      throw new ConflictException({ error: 'account_exists', message: 'This person already uses Attendra with another practice. Invitations for existing accounts are coming soon.' });
    }
    const password = temporaryPassword();
    const userId = await createAccount(this.auth, { email: body.email, name: body.name, password });
    // the account and the membership are not one transaction: an account left with no
    // membership would answer account_exists to every later try, so it is removed
    let result: TeamResult;
    try {
      result = await this.change(orgId, staff, { type: 'add', userId, role: body.role, temporary: true });
    } catch (err) {
      await deleteNewAccount(this.auth, userId);
      throw err;
    }
    if (result !== 'done') await deleteNewAccount(this.auth, userId);
    this.check(result);
    return { userId, temporaryPassword: password, expiresInHours: TEMPORARY_PASSWORD_HOURS };
  }

  @Post(':userId/reset-password')
  @HttpCode(200)
  @Requires('members:manage')
  @ApiOperation({ summary: 'Issue a new temporary password and sign the person out everywhere. Audited.' })
  @ApiOkResponse({ schema: schemaOf(AddedMember) })
  @ApiForbiddenResponse({ description: 'Your own account, or a manager resetting an owner' })
  async reset(@Param('clinicId') clinicId: string, @Param('userId') userId: string, @CurrentStaff() staff: Staff): Promise<AddedMember> {
    const orgId = await this.org(clinicId);
    const password = temporaryPassword();
    this.check(await this.change(orgId, staff, { type: 'reset', userId, passwordHash: await hashPassword(this.auth, password) }));
    return { userId, temporaryPassword: password, expiresInHours: TEMPORARY_PASSWORD_HOURS };
  }

  @Patch(':userId')
  @HttpCode(204)
  @Requires('members:manage')
  @ApiOperation({ summary: 'Change someone\'s role. Audited with the new role.' })
  @ApiBody({ schema: schemaOf(ChangeRole) })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({ description: 'A manager changing an owner, or anyone changing their own role' })
  async changeRole(@Param('clinicId') clinicId: string, @Param('userId') userId: string, @Body(new ZodPipe(ChangeRole)) body: z.infer<typeof ChangeRole>, @CurrentStaff() staff: Staff) {
    this.check(await this.change(await this.org(clinicId), staff, { type: 'role', userId, role: body.role }));
  }

  @Delete(':userId')
  @HttpCode(204)
  @Requires('members:manage')
  @ApiOperation({ summary: 'Remove someone from the organization. Their requests go back to the queue; they are signed out if they belong nowhere else. Audited.' })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({ description: 'Removing yourself, or a manager removing an owner' })
  async remove(@Param('clinicId') clinicId: string, @Param('userId') userId: string, @CurrentStaff() staff: Staff) {
    this.check(await this.change(await this.org(clinicId), staff, { type: 'remove', userId }));
  }

  private change(orgId: string, staff: Staff, change: TeamChange) {
    return changeTeam(this.db, orgId, { userId: staff.userId, role: staff.role! }, change, this.now());
  }

  private check(r: TeamResult) {
    if (r !== 'done' && r !== 'unchanged') throw REFUSED[r]();
  }

  private async org(clinicId: string) {
    const orgId = await orgOfClinic(this.db, clinicId);
    if (!orgId) throw new NotFoundException({ error: 'not_found' });
    return orgId;
  }
}
