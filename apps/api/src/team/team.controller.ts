// SPDX-License-Identifier: AGPL-3.0-only
import { changeTeam, type Database, inviteToTeam, listMembers, membershipCount, type StaffRole, type TeamChange, type TeamResult, TEMPORARY_PASSWORD_HOURS } from '@attendra/db';
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
import { ROLE_LABEL } from '../access';
import { createAccount, createInvitedAccount, deleteNewAccount, findAccount, hashPassword, hasPassword, setPasswordLink, temporaryPassword } from '../members';

// neither "with another practice" nor anything else about the account: it is not ours to tell
const NOT_HERE = { error: 'account_exists', message: 'This email address cannot be added here. Ask the person for another address, or write to Attendra support.' };

const ALL_LOCATIONS_OWNER_ONLY = () => new ForbiddenException({ error: 'forbidden', message: 'Only an owner can invite someone to every location.' });

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
 * The people who can open this location: its owners (account-wide) and the people
 * invited to it, each with their role here. Owners and managers add, change, reset and
 * remove them; a change to anyone but an owner holds at this location only. Each change and its audit rows happen in one
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
  @ApiOperation({ summary: 'Everyone who can open this location: its owners (every location) and the people invited to it, with their role here and two-step sign-in' })
  @ApiOkResponse({ schema: schemaOf(MemberList) })
  async list(@Param('clinicId') clinicId: string, @CurrentStaff() staff: Staff): Promise<MemberList> {
    const members = await listMembers(this.db, clinicId);
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
    if (body.role === 'owner' && staff.role !== 'owner') throw REFUSED.owner_grant();
    if (body.allLocations && staff.role !== 'owner') throw ALL_LOCATIONS_OWNER_ONLY();
    const email = body.email.trim().toLowerCase();
    // only a name that was typed: a person added by email alone writes their own, from Your profile
    const name = body.name ?? '';
    const existing = await findAccount(this.auth, email);
    if (existing && !body.allLocations && (await listMembers(this.db, clinicId)).some((m) => m.userId === existing.id)) throw REFUSED.already_member();
    if (!this.mail) {
      // nothing can be emailed: a new person gets a temporary password to pass on in person, as before (this location only)
      if (!existing) return { status: 'invite_sent', email, ...(await this.addNew(clinicId, staff, { ...body, email, name })) };
      // someone this practice removed earlier, who belongs to no team now: added back, with a new temporary password
      if (existing.emailVerified && (await membershipCount(this.db, existing.id)) === 0) {
        const password = temporaryPassword();
        const result = await this.change(clinicId, staff, { type: 'add', userId: existing.id, role: body.role, temporary: true, approvesRefills: body.approvesRefills, passwordHash: await hashPassword(this.auth, password) });
        if (result === 'done') return { status: 'invite_sent', email, userId: existing.id, temporaryPassword: password, expiresInHours: TEMPORARY_PASSWORD_HOURS };
        // removed by another practice: invited, like anyone else with a login
        if (result !== 'account_exists' && result !== 'other_organizations') this.check(result);
      }
    }
    return this.invite(clinicId, staff, { ...body, email, name }, existing, body.name);
  }

  /**
   * An invitation, and its email where the deployment sends email. With email, a new
   * address is invited too, on an account with no password, and its email carries the link
   * to set one: the same work and the same answer for every address.
   */
  private async invite(clinicId: string, staff: Staff, body: { email: string; name: string; role: StaffRole; approvesRefills: boolean; allLocations: boolean }, existing: { id: string; name: string } | null, typedName?: string): Promise<AddResult> {
    const userId = existing?.id ?? await createInvitedAccount(this.auth, body);
    let sent: Awaited<ReturnType<typeof inviteToTeam>>;
    try {
      sent = await inviteToTeam(this.db, clinicId, { userId: staff.userId, role: staff.role! }, body, this.now());
    } catch (err) {
      if (!existing) await deleteNewAccount(this.auth, userId);
      throw err;
    }
    if (sent.result !== 'done') {
      if (!existing) await deleteNewAccount(this.auth, userId);
      throw sent.result === 'all_locations_owner_only' ? ALL_LOCATIONS_OWNER_ONLY() : REFUSED[sent.result]();
    }
    if (this.mail) {
      // the link opens this invitation's own page: accept or decline there, after signing in (or setting a password) if needed
      const url = `${this.options.publicUrl}/invite/${encodeURIComponent(sent.id)}`;
      const setPasswordUrl = (await hasPassword(this.auth, userId)) ? undefined : await setPasswordLink(this.auth, this.options.publicUrl, userId, sent.expiresAt, `/invite/${sent.id}`);
      // not awaited: an answer that waited for the email would take longer for some addresses than others
      // greeted by their own name, or by the name typed in Add people as it was typed; with neither, the
      // email says "Hi," and not the start of their address
      void this.mail({ type: 'team_invitation', email: body.email, name: existing?.name ?? typedName ?? '', clinicName: sent.locations.length > 1 ? `${sent.organizationName} (${sent.locations.length} locations)` : body.role === 'owner' ? `${sent.organizationName} (every location)` : sent.clinicName, role: ROLE_LABEL[body.role], expiresAt: sent.expiresAt.toISOString(), url, ...(setPasswordUrl ? { setPasswordUrl } : {}) });
    }
    return { status: 'invite_sent', email: body.email };
  }

  /** A new account and its membership, with a temporary password returned once. */
  private async addNew(clinicId: string, staff: Staff, body: { email: string; name: string; role: StaffRole; approvesRefills: boolean }) {
    const password = temporaryPassword();
    const userId = await createAccount(this.auth, { email: body.email, name: body.name, password });
    // the account and the membership are not one transaction: an account left with no
    // membership would be invited rather than added on every later try, so it is removed
    let result: TeamResult;
    try {
      result = await this.change(clinicId, staff, { type: 'add', userId, role: body.role, temporary: true, approvesRefills: body.approvesRefills });
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
    const password = temporaryPassword();
    this.check(await this.change(clinicId, staff, { type: 'reset', userId, passwordHash: await hashPassword(this.auth, password) }));
    return { userId, temporaryPassword: password, expiresInHours: TEMPORARY_PASSWORD_HOURS };
  }

  @Post(':userId/reset-two-factor')
  @HttpCode(204)
  @Requires('members:manage')
  @ApiOperation({ summary: 'A lost phone: turn off the person\'s two-step sign-in and sign them out everywhere; they set it up again at their next sign-in. Audited.' })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({ description: 'Your own account, or a manager resetting an owner' })
  async resetTwoFactor(@Param('clinicId') clinicId: string, @Param('userId') userId: string, @CurrentStaff() staff: Staff) {
    this.check(await this.change(clinicId, staff, { type: 'two_factor', userId }));
  }

  @Patch(':userId')
  @HttpCode(204)
  @Requires('members:manage')
  @ApiOperation({ summary: 'Change someone\'s role at this location, or whether they may approve refills. Making someone an owner opens every location of the business; an owner made something else keeps that role at every location. Audited.' })
  @ApiBody({ schema: schemaOf(ChangeMember) })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({ description: 'A manager changing an owner, or anyone changing their own role (an owner may mark themselves as approving refills)' })
  async changeMember(@Param('clinicId') clinicId: string, @Param('userId') userId: string, @Body(new ZodPipe(ChangeMember)) body: z.infer<typeof ChangeMember>, @CurrentStaff() staff: Staff) {
    if (body.role !== undefined) this.check(await this.change(clinicId, staff, { type: 'role', userId, role: body.role }));
    if (body.approvesRefills !== undefined) this.check(await this.change(clinicId, staff, { type: 'refills', userId, approves: body.approvesRefills }));
  }

  @Delete(':userId')
  @HttpCode(204)
  @Requires('members:manage')
  @ApiOperation({ summary: 'Remove someone from this location (an owner: from the business). Their requests here go back to the queue; their other locations stay; they are signed out if they belong nowhere else. Audited.' })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({ description: 'Removing yourself, or a manager removing an owner' })
  async remove(@Param('clinicId') clinicId: string, @Param('userId') userId: string, @CurrentStaff() staff: Staff) {
    this.check(await this.change(clinicId, staff, { type: 'remove', userId }));
  }

  private change(clinicId: string, staff: Staff, change: TeamChange) {
    return changeTeam(this.db, clinicId, { userId: staff.userId, role: staff.role! }, change, this.now());
  }

  private check(r: TeamResult) {
    if (r !== 'done' && r !== 'unchanged') throw REFUSED[r]();
  }
}
