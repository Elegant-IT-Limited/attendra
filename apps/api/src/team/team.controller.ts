// SPDX-License-Identifier: AGPL-3.0-only
import { auditMemberChange, type Database, listMembers, orgOfClinic, removeMember, setMemberRole, type StaffRole } from '@attendra/db';
import { Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { ApiBody, ApiConflictResponse, ApiCookieAuth, ApiForbiddenResponse, ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import type { Auth } from '../auth';
import { AddedMember, AddMember, ChangeRole, MemberList } from '../contracts';
import { schemaOf } from '../http/openapi';
import { CurrentStaff, Requires, type Staff } from '../http/staff.guard';
import { AUTH, DB } from '../http/tokens';
import { ZodPipe } from '../http/zod.pipe';
import { addMember } from '../members';

/** 16 characters from 12 random bytes: long enough for Better Auth's 12-character minimum, short enough to read out. */
const temporaryPassword = () => randomBytes(12).toString('base64url');

/**
 * The people who can sign in to this clinic's organization. Owners and managers
 * add, change and remove them; a manager cannot touch an owner or make anyone one,
 * nobody removes themselves, and the last owner stays. Every change is audited in
 * each clinic of the organization. Adding someone uses the same path as
 * `pnpm add-member`, so there is no second way in.
 */
@ApiTags('team')
@ApiCookieAuth()
@ApiParam({ name: 'clinicId', example: 'clinic_maple' })
@Controller('clinics/:clinicId/members')
export class TeamController {
  constructor(@Inject(DB) private readonly db: Database, @Inject(AUTH) private readonly auth: Auth) {}

  @Get()
  @Requires('members:manage')
  @ApiOperation({ summary: 'Everyone in the clinic\'s organization, with their role, two-step sign-in and last sign-in' })
  @ApiOkResponse({ schema: schemaOf(MemberList) })
  async list(@Param('clinicId') clinicId: string, @CurrentStaff() staff: Staff): Promise<MemberList> {
    const members = await listMembers(this.db, await this.org(clinicId));
    return {
      members: members.map((m) => ({
        ...m, you: m.userId === staff.userId, addedAt: m.addedAt.toISOString(),
        lastSignInAt: m.lastSignInAt ? new Date(m.lastSignInAt).toISOString() : null,
      })),
    };
  }

  @Post()
  @HttpCode(200)
  @Requires('members:manage')
  @ApiOperation({ summary: 'Add a person with a role. Returns a temporary password once, to pass on in person. Audited.' })
  @ApiBody({ schema: schemaOf(AddMember) })
  @ApiOkResponse({ schema: schemaOf(AddedMember) })
  @ApiConflictResponse({ description: 'They are already a member' })
  async add(@Param('clinicId') clinicId: string, @Body(new ZodPipe(AddMember)) body: z.infer<typeof AddMember>, @CurrentStaff() staff: Staff): Promise<AddedMember> {
    this.mayGrant(staff, body.role);
    const orgId = await this.org(clinicId);
    const email = body.email.trim().toLowerCase();
    const members = await listMembers(this.db, orgId);
    if (members.some((m) => m.email === email)) throw new ConflictException({ error: 'already_member', message: 'This person is already on the team. Change their role instead.' });
    const existing = await (await this.auth.$context).internalAdapter.findUserByEmail(email);
    const password = existing ? null : temporaryPassword();
    const userId = await addMember(this.auth, this.db, { email, name: body.name, password: password ?? temporaryPassword(), orgId, role: body.role });
    await auditMemberChange(this.db, orgId, { actor: `user:${staff.userId}`, action: 'member.added', memberId: userId });
    return { userId, temporaryPassword: password };
  }

  @Patch(':userId')
  @HttpCode(204)
  @Requires('members:manage')
  @ApiOperation({ summary: 'Change someone\'s role. Audited.' })
  @ApiBody({ schema: schemaOf(ChangeRole) })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({ description: 'A manager changing an owner, or anyone changing their own role' })
  async change(@Param('clinicId') clinicId: string, @Param('userId') userId: string, @Body(new ZodPipe(ChangeRole)) body: z.infer<typeof ChangeRole>, @CurrentStaff() staff: Staff) {
    const orgId = await this.org(clinicId);
    const target = await this.member(orgId, userId);
    if (userId === staff.userId) throw new ForbiddenException({ error: 'forbidden', message: 'You cannot change your own role. Ask another owner or manager.' });
    this.mayManage(staff, target.role);
    this.mayGrant(staff, body.role);
    if (target.role === body.role) return;
    await this.keepAnOwner(orgId, target.role);
    await setMemberRole(this.db, orgId, userId, body.role);
    await auditMemberChange(this.db, orgId, { actor: `user:${staff.userId}`, action: 'member.role.changed', memberId: userId });
  }

  @Delete(':userId')
  @HttpCode(204)
  @Requires('members:manage')
  @ApiOperation({ summary: 'Remove someone from the organization and sign them out everywhere. Audited.' })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({ description: 'Removing yourself, or a manager removing an owner' })
  async remove(@Param('clinicId') clinicId: string, @Param('userId') userId: string, @CurrentStaff() staff: Staff) {
    const orgId = await this.org(clinicId);
    const target = await this.member(orgId, userId);
    if (userId === staff.userId) throw new ForbiddenException({ error: 'forbidden', message: 'You cannot remove yourself.' });
    this.mayManage(staff, target.role);
    await this.keepAnOwner(orgId, target.role);
    await removeMember(this.db, orgId, userId);
    await auditMemberChange(this.db, orgId, { actor: `user:${staff.userId}`, action: 'member.removed', memberId: userId });
  }

  private mayManage(staff: Staff, targetRole: StaffRole) {
    if (targetRole === 'owner' && staff.role !== 'owner') throw new ForbiddenException({ error: 'forbidden', message: 'Only an owner can change or remove an owner.' });
  }

  private mayGrant(staff: Staff, role: StaffRole) {
    if (role === 'owner' && staff.role !== 'owner') throw new ForbiddenException({ error: 'forbidden', message: 'Only an owner can make someone an owner.' });
  }

  private async keepAnOwner(orgId: string, targetRole: StaffRole) {
    if (targetRole !== 'owner') return;
    const owners = (await listMembers(this.db, orgId)).filter((m) => m.role === 'owner').length;
    if (owners <= 1) throw new ConflictException({ error: 'last_owner', message: 'This is the last owner. Make someone else an owner first.' });
  }

  private async member(orgId: string, userId: string) {
    const m = (await listMembers(this.db, orgId)).find((x) => x.userId === userId);
    if (!m) throw new NotFoundException({ error: 'not_found' });
    return m;
  }

  private async org(clinicId: string) {
    const orgId = await orgOfClinic(this.db, clinicId);
    if (!orgId) throw new NotFoundException({ error: 'not_found' });
    return orgId;
  }
}
