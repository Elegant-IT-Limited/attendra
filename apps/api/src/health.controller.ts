// SPDX-License-Identifier: AGPL-3.0-only
import { type Database, databaseAnswers } from '@attendra/db';
import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { Public } from './http/staff.guard';
import { API_OPTIONS, type ApiOptions, DB } from './http/tokens';

/** How long the health check waits for the database before it calls it down. */
export const HEALTH_DB_TIMEOUT_MS = 1000;

@ApiExcludeController()
@Controller('health')
export class HealthController {
  constructor(@Inject(API_OPTIONS) private readonly options: ApiOptions, @Inject(DB) private readonly db: Database) {}

  /**
   * Liveness, and what the sign-in page offers: the demo logins on a demo, "Forgot
   * password" when the hosting layer can email the link, and, on a hosted deployment
   * (it has account pages under /account), sign-up and a new confirmation link.
   * The database is asked first: down, or slower than a second, the answer is 503 with
   * `ok: false`, so the outside uptime check (any answer but 200 is down) says it.
   */
  @Get()
  @Public()
  async health(@Res({ passthrough: true }) reply: FastifyReply) {
    if (!(await databaseAnswers(this.db, HEALTH_DB_TIMEOUT_MS))) {
      reply.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { ok: false, database: 'down' };
    }
    const hosted = !!this.options.accountLinks?.length;
    return {
      ok: true, database: 'ok', demoMode: this.options.demoMode, ...(this.options.demoSignIn ? { demoSignIn: this.options.demoSignIn } : {}),
      passwordReset: !!this.options.passwordReset,
      ...(hosted ? { signupUrl: '/account/signup', resendUrl: '/account/resend' } : {}),
    };
  }
}
