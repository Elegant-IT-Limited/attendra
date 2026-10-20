// SPDX-License-Identifier: AGPL-3.0-only
import { Controller, Get, Inject } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from './http/staff.guard';
import { API_OPTIONS, type ApiOptions } from './http/tokens';

@ApiExcludeController()
@Controller('health')
export class HealthController {
  constructor(@Inject(API_OPTIONS) private readonly options: ApiOptions) {}

  /**
   * Liveness, and what the sign-in page offers: the demo logins on a demo, "Forgot
   * password" when the hosting layer can email the link, and, on a hosted deployment
   * (it has account pages under /account), sign-up and a new confirmation link.
   */
  @Get()
  @Public()
  health() {
    const hosted = !!this.options.accountLinks?.length;
    return {
      ok: true, demoMode: this.options.demoMode, ...(this.options.demoSignIn ? { demoSignIn: this.options.demoSignIn } : {}),
      passwordReset: !!this.options.passwordReset,
      ...(hosted ? { signupUrl: '/account/signup', resendUrl: '/account/resend' } : {}),
    };
  }
}
