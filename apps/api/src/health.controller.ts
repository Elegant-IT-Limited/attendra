// SPDX-License-Identifier: AGPL-3.0-only
import { Controller, Get, Inject } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from './http/staff.guard';
import { API_OPTIONS, type ApiOptions } from './http/tokens';

@ApiExcludeController()
@Controller('health')
export class HealthController {
  constructor(@Inject(API_OPTIONS) private readonly options: ApiOptions) {}

  /** Liveness, and whether this is a demo deployment (the sign-in page shows the demo logins). */
  @Get()
  @Public()
  health() {
    return { ok: true, demoMode: this.options.demoMode, ...(this.options.demoSignIn ? { demoSignIn: this.options.demoSignIn } : {}) };
  }
}
