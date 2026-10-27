// SPDX-License-Identifier: AGPL-3.0-only
import { changeTeam, type Database, inviteToTeam, listMembers, membershipCount, orgOfClinic, type StaffRole, type TeamChange, type TeamResult, TEMPORARY_PASSWORD_HOURS } from '@attendra/db';
import { Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { ApiBody, ApiConflictResponse, ApiCookieAuth, ApiCreatedResponse, ApiForbiddenResponse, ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import type { Auth } from '../auth';
import { AddedMember, AddMember, AddResult, ChangeMember, MemberList } from '../contracts';
import { schemaOf } from '../http/openapi';
import { CurrentStaff, Requires, type Staff } from '../http/staff.guard';
import { API_OPTIONS, type ApiOptions, AUTH, CLOCK, DB, MAIL } from '../http/tokens';
import { ZodPipe } from '../http/zod.pipe';
import type { Mailer } from '../mail-hook';
import { avatarUrl } from '../me/avatar';
import { createAccount, createInvitedAccount, deleteNewAccount, findAccount, hashPassword, hasPassword, ROLE_LABEL, setPasswordLink, temporaryPassword } from '../members';

// neither "with another practice" nor anything else about the account: it is not ours to tell
const NOT_HERE = { error: 'account_exists', message: 'This email address cannot be added here. Ask the person for another address, or write to Attendra support.' };

export const REFUSED: Record<Exclude<TeamResult, 'done' | 'unchanged'>, () => Error> = {
  account_exists: () => new ConflictException(NOT_HERE),
  not_found: () => new NotFoundException({ error: 'not_found' }),
  already_member: () => new ConflictException({ error: 'already_member', message: 'This person is already on the team. Change their role instead.' }),
  self: () => new ForbiddenException({ error: 'forbidden', message: 'You cannot do that to your own account here. Ask another owner or manager.' }),
  owner_protected: () => new ForbiddenException({ error: 'forbidden', message: 'Only an owner can change, reset or remove an owner.' }),
  owner_grant: () => new ForbiddenException({ error: 'forbidden', message: 'Only an owner can make someone an owner.' }),
  last_owner: () => new ConflictException({ error: 'last_owner', message: 'This is the last owner. Make someone else an owner first.' }),
  other_organizations: () => new ConflictException({ error: 'other_organizations', message: 'This person also works for another practice on Attendra, so their password and two-step sign-in cannot be reset from here. They can use "Forgot your password?" on the sign-in page, or write to Attendra support.' }),
};

/**
 * The people who can sign in to this clinic's organization. Owners and managers
 * add, change, reset and remove them. Each change and its audit rows happen in one
 * transaction with the team locked (changeTeam), so the rules hold under races: a
 * manager cannot touch an owner or make one, nobody changes, resets or removes
 * themselves here, and the last owner stays.
 *
 * Adding answers "invite sent" for every email, so a clinic never learns who already
 * has an Attendra login: such a person is invited (invitations.controller.ts) and joins
 * by accepting. Where the deployment sends email, a new address is invited the same way
 * and sets its own password from the email. Where it cannot, a new person gets a
 * temporary password, shown once: it must be changed at first sign-in and expires after
 * 72 hours, so the manager who read it out never holds a working password for someone else.
 */
@ApiTags('team')
@ApiCookieAuth()
@ApiParam({ name: 'clinicId', example: 'clinic_maple' })
@Controller('clinics/:clinicId/members')
export class TeamController {
  constructor(
    @Inject(DB) private readonly db: Database, @Inject(AUTH) private readonly auth: Auth, @Inject(CLOCK) private readonly now: () => Date,
    @Inject(API_OPTIONS) private readonly options: ApiOptions, @Inject(MAIL) private readonly mail: Mailer | null,
  ) {}

  @Get()
  @Requires('members:manage')
  @ApiOperation({ summary: 'Everyone in the clinic\'s organization, with their role and two-step sign-in' })
  @ApiOkResponse({ schema: schemaOf(MemberList) })
  async list(@Param('clinicId') clinicId: string, @CurrentStaff() staff: Staff): Promise<MemberList> {
    const members = await listMembers(this.db, await this.org(clinicId));
    return { members: members.map(({ avatarAt, ...m }) => ({ ...m, you: m.userId === staff.userId, addedAt: m.addedAt.toISOString(), avatarUrl: avatarUrl(m.userId, avatarAt) })) };
  }

  @Post()
  @HttpCode(201)
  @Requires('members:manage')
  @ApiOperation({ summary: 'Add a person with a role. Every email gets the same answer, "invite sent", so it never says who already has an Attendra login: such a person is invited, and accepts or declines from their own dashboard (and by email, where the deployment sends email). Where the deployment sends email, a new email is invited the same way, with a link to set a password. Where it cannot, a new email gets an account and a temporary password, returned once: it must be changed at first sign-in and expires after 72 hours. Audited.' })
  @ApiBody({ schema: schemaOf(AddMember) })
  @ApiCreatedResponse({ schema: schemaOf(AddResult) })
  @ApiConflictResponse({ description: 'Already on the team (already_member)' })
  async add(@Param('clinicId') clinicId: string, @Body(new ZodPipe(AddMember)) body: z.infer<typeof AddMember>, @CurrentStaff() staff: Staff): Promise<AddResult> {
    const orgId = await this.org(clinicId);
    if (body.role === 'owner' && staff.role !== 'owner') throw REFUSED.owner_grant();
    const email = body.email.trim().toLowerCase();
    const name = body.name || email.split('@')[0]!;
    const existing = await findAccount(this.auth, email);
    if (existing && (await listMembers(this.db, orgId)).some((m) => m.userId === existing.id)) throw REFUSED.already_member();
    if (!this.mail) {
      // nothing can be emailed: a new person gets a temporary password to pass on in person, as before
      if (!existing) return { status: 'invite_sent', email, ...(await this.addNew(orgId, staff, { ...body, email, name })) };
      // someone this practice removed earlier, who belongs to no team now: added back, with a new temporary password
      if (existing.emailVerified && (await membershipCount(this.db, existing.id)) === 0) {
        const password = temporaryPassword();
        const result = await this.change(orgId, staff, { type: 'add', userId: existing.id, role: body.role, temporary: true, approvesRefills: body.approvesRefills, passwordHash: await hashPassword(this.auth, password) });
        if (result === 'done') return { status: 'invite_sent', email, userId: existing.id, temporaryPassword: password, expiresInHours: TEMPORARY_PASSWORD_HOURS };
        // removed by another practice: invited, like anyone else with a login
        if (result !== 'account_exists' && result !== 'other_organizations') this.check(result);
      }
    }
    return this.invite(orgId, clinicId, staff, { ...body, email, name }, existing, body.name);
  }

  /**
   * An invitation, and its email where the deployment sends email. With email, a new
   * address is invited too, on an account with no password, and its email carries the link
   * to set one: the same work and the same answer for every address.
   */
  private async invite(orgId: string, clinicId: string, staff: Staff, body: { email: string; name: string; role: StaffRole; approvesRefills: boolean }, existing: { id: string; name: string } | null, typedName?: string): Promise<AddResult> {
    const userId = existing?.id ?? await createInvitedAccount(this.auth, body);
    let sent: Awaited<ReturnType<typeof inviteToTeam>>;
    try {
      sent = await inviteToTeam(this.db, orgId, clinicId, { userId: staff.userId, role: staff.role! }, body, this.now());
    } catch (err) {
      if (!existing) await deleteNewAccount(this.auth, userId);
      throw err;
    }
    if (sent.result !== 'done') {
      if (!existing) await deleteNewAccount(this.auth, userId);
      throw REFUSED[sent.result]();
    }
    if (this.mail) {
      const setPasswordUrl = (await hasPassword(this.auth, userId)) ? undefined : await setPasswordLink(this.auth, this.options.publicUrl, userId, sent.expiresAt);
      // not awaited: an answer that waited for the email would take longer for some addresses than others
      // greeted by their own name, or by the name typed in Add people as it was typed; with neither, the
      // email says "Hi," and not the start of their address
      void this.mail({ type: 'team_invitation', email: body.email, name: existing?.name ?? typedName ?? '', clinicName: sent.clinicName, role: ROLE_LABEL[body.role], expiresAt: sent.expiresAt.toISOString(), url: `${this.options.publicUrl}/`, ...(setPasswordUrl ? { setPasswordUrl } : {}) });
    }
    return { status: 'invite_sent', email: body.email };
  }

  /** A new account and its membership, with a temporary password returned once. */
  private async addNew(orgId: string, staff: Staff, body: { email: string; name: string; role: StaffRole; approvesRefills: boolean }) {
    const password = temporaryPassword();
    const userId = await createAccount(this.auth, { email: body.email, name: body.name, password });
    // the account and the membership are not one transaction: an account left with no
    // membership would be invited rather than added on every later try, so it is removed
    let result: TeamResult;
    try {
      result = await this.change(orgId, staff, { type: 'add', userId, role: body.role, temporary: true, approvesRefills: body.approvesRefills });
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

  @Post(':userId/reset-two-factor')
  @HttpCode(204)
  @Requires('members:manage')
  @ApiOperation({ summary: 'A lost phone: turn off the person\'s two-step sign-in and sign them out everywhere; they set it up again at their next sign-in. Audited.' })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({ description: 'Your own account, or a manager resetting an owner' })
  async resetTwoFactor(@Param('clinicId') clinicId: string, @Param('userId') userId: string, @CurrentStaff() staff: Staff) {
    this.check(await this.change(await this.org(clinicId), staff, { type: 'two_factor', userId }));
  }

  @Patch(':userId')
  @HttpCode(204)
  @Requires('members:manage')
  @ApiOperation({ summary: 'Change someone\'s role, or whether they may approve refills. Audited.' })
  @ApiBody({ schema: schemaOf(ChangeMember) })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({ description: 'A manager changing an owner, or anyone changing their own role (an owner may mark themselves as approving refills)' })
  async changeMember(@Param('clinicId') clinicId: string, @Param('userId') userId: string, @Body(new ZodPipe(ChangeMember)) body: z.infer<typeof ChangeMember>, @CurrentStaff() staff: Staff) {
    const orgId = await this.org(clinicId);
    if (body.role !== undefined) this.check(await this.change(orgId, staff, { type: 'role', userId, role: body.role }));
    if (body.approvesRefills !== undefined) this.check(await this.change(orgId, staff, { type: 'refills', userId, approves: body.approvesRefills }));
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
