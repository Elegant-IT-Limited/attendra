// SPDX-License-Identifier: AGPL-3.0-only
import 'reflect-metadata';
import { type Database, FrontDeskRepository, type PhiCipher, ScheduleRepository } from '@attendra/db';
import { StaffScheduler } from '@attendra/scheduling';
import type { Logger } from '@attendra/observability';
import rateLimit from '@fastify/rate-limit';
import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AuditController } from './audit/audit.controller';
import type { Auth } from './auth';
import { CallsController } from './calls/calls.controller';
import { TestCallsController } from './calls/test-calls.controller';
import { HealthController } from './health.controller';
import { StaffGuard, toHeaders } from './http/staff.guard';
import { API_OPTIONS, type ApiOptions, AUTH, CLOCK, DB, FRONT_DESK, LOGGER, SCHEDULE, STAFF_SCHEDULER, VOICE, type VoiceClient } from './http/tokens';
import { MeController } from './me/me.controller';
import { AppointmentsController } from './schedule/appointments.controller';
import { SettingsController } from './settings/settings.controller';
import { TasksController } from './tasks/tasks.controller';
import pkg from '../package.json' with { type: 'json' };

const { version } = pkg;

export interface ApiDeps {
  db: Database;
  cipher: PhiCipher;
  auth: Auth;
  log: Logger;
  options: ApiOptions;
  /** The voice service, for browser test calls. Without it the endpoint answers 503. */
  voice?: VoiceClient | null;
  /** Requests per address per minute on /api/v1. Behind the web proxy, set trustProxy. */
  rateLimit?: number;
  /** Proxy hops in front of the API whose X-Forwarded-For is trusted (1 behind the dashboard). */
  trustProxy?: number;
  /** The clock for booking rules ("no past times"). Tests set it; the default is the real time. */
  now?: () => Date;
}

// The Better Auth routes the dashboard uses. Everything else Better Auth could serve
// (organization and member admin, account changes) stays closed: those routes sit
// outside StaffGuard, so they would skip the two-factor rule. Members are managed
// with `pnpm add-member` in v0.2.
const AUTH_ROUTES = new Set([
  'POST /sign-in/email', 'POST /sign-out', 'GET /get-session',
  'POST /two-factor/enable', 'POST /two-factor/verify-totp', 'POST /two-factor/verify-backup-code',
]);

@Module({})
class ApiModule {
  static with(deps: ApiDeps): DynamicModule {
    return {
      module: ApiModule,
      controllers: [HealthController, MeController, CallsController, TestCallsController, TasksController, AppointmentsController, SettingsController, AuditController],
      providers: [
        { provide: DB, useValue: deps.db },
        { provide: AUTH, useValue: deps.auth },
        { provide: LOGGER, useValue: deps.log },
        { provide: API_OPTIONS, useValue: deps.options },
        { provide: VOICE, useValue: deps.voice ?? null },
        { provide: FRONT_DESK, useValue: new FrontDeskRepository(deps.db, deps.cipher) },
        { provide: SCHEDULE, useValue: new ScheduleRepository(deps.db, deps.cipher) },
        { provide: STAFF_SCHEDULER, useValue: new StaffScheduler(deps.db, deps.cipher, deps.now) },
        { provide: CLOCK, useValue: deps.now ?? (() => new Date()) },
        { provide: APP_GUARD, useClass: StaffGuard },
      ],
    };
  }
}

/**
 * The dashboard API, ready to listen. Nest serves /api/v1 (every route behind
 * StaffGuard, except /api/v1/health), Better Auth serves /api/auth, and the
 * OpenAPI document is at /api/docs.
 */
export async function createApi(deps: ApiDeps): Promise<NestFastifyApplication> {
  const hops = deps.trustProxy ?? 0;
  // trust exactly `hops` proxies (the dashboard), so a client-sent X-Forwarded-For entry never becomes the address
  const adapter = new FastifyAdapter({ trustProxy: (_address: string, hop: number) => hop < hops, bodyLimit: 512 * 1024 });
  const app = await NestFactory.create<NestFastifyApplication>(ApiModule.with(deps), adapter, { logger: false });
  app.setGlobalPrefix('api/v1');
  const fastify = app.getHttpAdapter().getInstance();

  // every route, Better Auth's included: sign-in is where guessing happens
  await fastify.register(rateLimit, { max: deps.rateLimit ?? 600, timeWindow: 60_000 });

  // Method, route and status only. Bodies and query strings can carry PHI.
  fastify.addHook('onResponse', async (req, reply) => {
    deps.log.info({ method: req.method, route: req.routeOptions.url, status: reply.statusCode, ms: Math.round(reply.elapsedTime) }, 'request');
  });
  // Nest turns thrown errors into responses; the server-side ones still need a trace.
  // Name and code only: a database error message can quote the values in a row.
  app.useGlobalFilters({
    catch(err: unknown, host: import('@nestjs/common').ArgumentsHost) {
      const reply = host.switchToHttp().getResponse<import('fastify').FastifyReply>();
      const req = host.switchToHttp().getRequest<import('fastify').FastifyRequest>();
      // an HttpException was thrown on purpose and says what went wrong; anything else is a bug
      const known = typeof (err as { getStatus?: () => number }).getStatus === 'function';
      const status = known ? (err as { getStatus: () => number }).getStatus() : 500;
      if (status >= 500) deps.log.error({ route: req.routeOptions.url, name: (err as Error).name, code: (err as { code?: string }).code }, 'request failed');
      const body = known ? (err as { getResponse: () => unknown }).getResponse() : { error: 'server_error' };
      void reply.status(status).send(typeof body === 'string' ? { error: body } : body);
    },
  });
  // Nothing from the API is cached anywhere: responses can hold transcripts and names.
  fastify.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
  });

  fastify.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: async (req, reply) => {
      const url = new URL(req.url, deps.options.publicUrl);
      if (!AUTH_ROUTES.has(`${req.method} ${url.pathname.replace(/^\/api\/auth/, '')}`)) return reply.status(404).send({ error: 'not_found' });
      const body = req.method === 'POST' && req.body !== undefined ? JSON.stringify(req.body) : undefined;
      const headers = toHeaders(req.headers);
      headers.set('x-forwarded-for', req.ip);
      const res = await deps.auth.handler(new Request(url, { method: req.method, headers, body }));
      reply.status(res.status);
      res.headers.forEach((value, key) => { if (key !== 'set-cookie') reply.header(key, value); });
      const cookies = res.headers.getSetCookie();
      if (cookies.length) reply.header('set-cookie', cookies);
      return reply.send(res.body ? await res.text() : null);
    },
  });

  const doc = new DocumentBuilder()
    .setTitle('Attendra dashboard API')
    .setDescription('What the staff dashboard uses. Sign in through /api/auth; the session cookie authenticates every call.')
    .setVersion(version)
    .addCookieAuth('attendra.session_token')
    .build();
  SwaggerModule.setup('api/docs', app, () => SwaggerModule.createDocument(app, doc));

  await app.init();
  return app;
}
