// SPDX-License-Identifier: AGPL-3.0-only
import { clinicsForUser, type Database } from '@attendra/db';
import { Controller, Get, Inject } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { permissionsFor } from '../access';
import { Me } from '../contracts';
import { schemaOf } from '../http/openapi';
import { BeforeTwoFactor, CurrentStaff, type Staff } from '../http/staff.guard';
import { API_OPTIONS, type ApiOptions, DB } from '../http/tokens';

@ApiTags('me')
@ApiCookieAuth()
@Controller('me')
export class MeController {
  constructor(@Inject(DB) private readonly db: Database, @Inject(API_OPTIONS) private readonly options: ApiOptions) {}

  @Get()
  @BeforeTwoFactor()
  @ApiOperation({ summary: 'The signed-in person, their clinics, and what they may do in each' })
  @ApiOkResponse({ schema: schemaOf(Me) })
  async me(@CurrentStaff() staff: Staff): Promise<Me> {
    const clinics = await clinicsForUser(this.db, staff.userId);
    return {
      user: { id: staff.userId, name: staff.name, email: staff.email, twoFactorEnabled: staff.twoFactorEnabled },
      demoMode: this.options.demoMode,
      clinics: clinics.map((c) => ({ id: c.clinicId, name: c.clinicName, timezone: c.timezone, role: c.role, permissions: permissionsFor(c.role) })),
    };
  }
}
