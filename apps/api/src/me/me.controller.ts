// SPDX-License-Identifier: AGPL-3.0-only
import { AVATAR_MAX_BYTES, avatarStamps, clinicsForUser, type Database, removeAvatar, renameUser, saveAvatar } from '@attendra/db';
import { Body, Controller, Delete, Get, HttpCode, HttpException, Inject, Patch, Put } from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiCookieAuth, ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { permissionsFor } from '../access';
import { AvatarSaved, Me, ProfileName } from '../contracts';
import { schemaOf } from '../http/openapi';
import { BeforeTwoFactor, CurrentStaff, type Staff } from '../http/staff.guard';
import { API_OPTIONS, type ApiOptions, CLOCK, DB, VOICE, type VoiceClient } from '../http/tokens';
import { ZodPipe } from '../http/zod.pipe';
import { AVATAR_TYPES, avatarUrl, imageTypeOf } from './avatar';

@ApiTags('me')
@ApiCookieAuth()
@Controller('me')
export class MeController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(API_OPTIONS) private readonly options: ApiOptions,
    @Inject(VOICE) private readonly voice: VoiceClient | null,
    @Inject(CLOCK) private readonly now: () => Date,
  ) {}

  @Get()
  @BeforeTwoFactor()
  @ApiOperation({ summary: 'The signed-in person, their clinics, and what they may do in each' })
  @ApiOkResponse({ schema: schemaOf(Me) })
  async me(@CurrentStaff() staff: Staff): Promise<Me> {
    const clinics = await clinicsForUser(this.db, staff.userId);
    const avatarAt = (await avatarStamps(this.db, [staff.userId])).get(staff.userId);
    return {
      user: { id: staff.userId, name: staff.name, email: staff.email, twoFactorEnabled: staff.twoFactorEnabled, mustChangePassword: staff.mustChangePassword, avatarUrl: avatarUrl(staff.userId, avatarAt), nameMissing: !staff.name.trim() },
      demoMode: this.options.demoMode,
      twoFactorRequired: !this.options.demoMode && this.options.twoFactor !== 'optional',
      idleMinutes: this.options.idleMinutes ?? 15,
      testCalls: !!this.voice?.browserCalls,
      simulatedCalls: !!this.voice?.simulatedCalls,
      clinics: clinics.map((c) => ({
        id: c.clinicId, name: c.clinicName, timezone: c.timezone, role: c.role, permissions: permissionsFor(c.role), approvesRefills: c.approvesRefills,
        accountLinks: c.role === 'owner' ? (this.options.accountLinks ?? []).map((l) => ({ label: l.label, href: l.href.replaceAll('{clinicId}', encodeURIComponent(c.clinicId)) })) : [],
      })),
    };
  }

  /** Your own name: the only one you can change here. A manager never renames someone else. */
  @Patch()
  @HttpCode(204)
  @ApiOperation({ summary: 'Change your own name, 2 to 80 characters. Audited as user.name.changed in each of your clinics, without the old or the new name.' })
  @ApiBody({ schema: schemaOf(ProfileName) })
  @ApiNoContentResponse()
  async rename(@Body(new ZodPipe(ProfileName)) body: z.infer<typeof ProfileName>, @CurrentStaff() staff: Staff) {
    await renameUser(this.db, staff.userId, body.name, this.now());
  }

  /**
   * Your picture, as the image itself: the dashboard sends a 256 px WebP it made in the
   * browser. The bytes must really be a WebP, PNG or JPEG (their first bytes say so, not
   * only the content-type), and 200 KB at most.
   */
  @Put('avatar')
  @HttpCode(200)
  @ApiOperation({ summary: 'Set your picture: a WebP, PNG or JPEG image as the body, 200 KB at most. Replaces the one before.' })
  @ApiConsumes(...AVATAR_TYPES)
  @ApiOkResponse({ schema: schemaOf(AvatarSaved) })
  async setAvatar(@Body() body: unknown, @CurrentStaff() staff: Staff): Promise<AvatarSaved> {
    if (!(body instanceof Uint8Array) || body.byteLength === 0) throw new HttpException({ error: 'not_an_image', message: 'Choose a JPEG, PNG or WebP picture.' }, 415);
    // a copy of the bytes, never the request's own value, from here on (CodeQL: no string or array can reach imageTypeOf)
    const bytes = Buffer.from(body);
    if (bytes.byteLength > AVATAR_MAX_BYTES) throw new HttpException({ error: 'too_large', message: 'This picture is too large. Choose a smaller one.' }, 413);
    const type = imageTypeOf(bytes);
    if (!type) throw new HttpException({ error: 'not_an_image', message: 'Choose a JPEG, PNG or WebP picture.' }, 415);
    const at = this.now();
    await saveAvatar(this.db, staff.userId, bytes, type, at);
    return { avatarUrl: avatarUrl(staff.userId, at)! };
  }

  @Delete('avatar')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove your picture: your initials show instead.' })
  @ApiNoContentResponse()
  async deleteAvatar(@CurrentStaff() staff: Staff) {
    await removeAvatar(this.db, staff.userId);
  }
}
