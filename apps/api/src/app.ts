// SPDX-License-Identifier: AGPL-3.0-only
import 'reflect-metadata';
import type { KnowledgeBase } from '@attendra/core';
import { type ChangeFeed, clearTemporaryPassword, type Database, type DbTime, endSessions, measureDb, FrontDeskRepository, passwordState, PATIENT_SCAN_LIMIT, PatientRecords, type PhiCipher, resetTokenUser, ScheduleRepository } from '@attendra/db';
import type { Answerer } from '@attendra/knowledge';
import { StaffScheduler } from '@attendra/scheduling';
import { type GuardOptions, type Resolver } from '@attendra/webhooks';
import { eventSink, type JobQueue, noJobs } from '@attendra/worker/queue';
import type { Logger } from '@attendra/observability';
import rateLimit from '@fastify/rate-limit';
import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ApiKeysController } from './api-keys/api-keys.controller';
import { AuditController } from './audit/audit.controller';
import type { Auth } from './auth';
import type { Mailer } from './mail-hook';
import { CallsController } from './calls/calls.controller';
import { ChangesController } from './changes/changes.controller';
import { DoctorsController } from './doctors/doctors.controller';
import { LiveController } from './calls/live.controller';
import { TestCallsController } from './calls/test-calls.controller';
import { HealthController } from './health.controller';
import { KnowledgeController } from './knowledge/knowledge.controller';
import { WebhooksController } from './webhooks/webhooks.controller';
import { clientAddress } from './http/client-address';
import { compressReply } from './http/compress';
import { rateLimitKey } from './http/rate-key';
import { StaffGuard, toHeaders } from './http/staff.guard';
import { IdempotencyInterceptor } from './http/idempotency';
import { API_OPTIONS, type ApiOptions, AUTH, CHANGES, CIPHER, CLOCK, DB, EVENTS, FRONT_DESK, JOBS, KNOWLEDGE, WEBHOOK_GUARD, LOGGER, MAIL, PATIENTS, SCHEDULE, STAFF_SCHEDULER, VOICE, VOICE_SAMPLES, type VoiceClient, type VoiceSampler } from './http/tokens';
import { MeController } from './me/me.controller';
import { UsersController } from './me/users.controller';
import { OverviewController } from './overview/overview.controller';
import { PlanController } from './overview/plan.controller';
import { PatientsController } from './patients/patients.controller';
import { ProvisioningController } from './provisioning/provisioning.controller';
import { QualityController } from './quality/quality.controller';
import { AppointmentsController } from './schedule/appointments.controller';
import { EmergencyReviewController } from './settings/emergency-review.controller';
import { SettingsController } from './settings/settings.controller';
import { VoiceSamplesController } from './voice-samples/voice-samples.controller';
import { TasksController } from './tasks/tasks.controller';
import { MyInvitationsController, TeamInvitationsController } from './team/invitations.controller';
import { TeamController } from './team/team.controller';
import { TextsController } from './texts/texts.controller';
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
  /** Where uploads are sent to be indexed. Without it a document stays queued. */
  jobs?: JobQueue;
  /** Search and answers over the clinic's documents, for the Ask a question box. */
  knowledge?: { base: KnowledgeBase; answerer: Answerer; embeddingModel?: string };
  /** Webhook URL checks. Only the local demo allows plain HTTP to this machine. */
  webhooks?: GuardOptions & { resolve?: Resolver };
  /** Requests per address per minute on /api/v1. Behind the web proxy, set trustProxy. */
  rateLimit?: number;
  /** Proxy hops in front of the API whose X-Forwarded-For is trusted (1 behind the dashboard). */
  trustProxy?: number;
  /** The edge proxy sits behind Cloudflare: a request that reached it from Cloudflare names its client in CF-Connecting-IP. */
  trustCloudflare?: boolean;
  /** The clock for booking rules ("no past times"). Tests set it; the default is the real time. */
  now?: () => Date;
  /** Change notices from Postgres, so the dashboard updates without a refresh. Without it, screens refresh on a timer. */
  changes?: ChangeFeed | null;
  /** Speaks the greeting in a voice, so Settings can play it. Without it the Listen button says samples are off. */
  voiceSamples?: VoiceSampler | null;
  /** The hosting layer's mail hook. With it, Team invitations are emailed and nobody is shown a temporary password. */
  mail?: Mailer | null;
}

// The Better Auth routes the dashboard uses. Everything else Better Auth could serve
// (organization and member admin, account changes) stays closed: those routes sit
// outside StaffGuard, so they would skip the two-factor rule. Members are managed
// through /api/v1/clinics/:clinicId/members, which is behind the guard, and with
// `pnpm add-member`.
const AUTH_ROUTES = new Set([
  'POST /sign-in/email', 'POST /sign-out', 'GET /get-session', 'POST /change-password',
  'POST /two-factor/enable', 'POST /two-factor/verify-totp', 'POST /two-factor/verify-backup-code',
  // a signed-in person replacing their phone or their backup codes (both ask for the password)
  'POST /two-factor/disable', 'POST /two-factor/generate-backup-codes',
  // "forgot password": the link is emailed by the hosting layer (ATTENDRA_MAIL_HOOK_URL)
  'POST /request-password-reset', 'POST /reset-password',
]);

@Module({})
class ApiModule {
  static with(deps: ApiDeps): DynamicModule {
    return {
      module: ApiModule,
      controllers: [HealthController, MeController, UsersController, ChangesController, OverviewController, PlanController, QualityController, CallsController, LiveController, KnowledgeController, WebhooksController, ApiKeysController, TestCallsController, TasksController, TextsController, AppointmentsController, PatientsController, DoctorsController, TeamController, TeamInvitationsController, MyInvitationsController, SettingsController, VoiceSamplesController, EmergencyReviewController, AuditController, ProvisioningController],
      providers: [
        { provide: DB, useValue: deps.db },
        { provide: CIPHER, useValue: deps.cipher },
        { provide: AUTH, useValue: deps.auth },
        { provide: LOGGER, useValue: deps.log },
        { provide: API_OPTIONS, useValue: deps.options },
        { provide: VOICE, useValue: deps.voice ?? null },
        { provide: JOBS, useValue: deps.jobs ?? noJobs },
        { provide: KNOWLEDGE, useValue: deps.knowledge ?? null },
        { provide: EVENTS, useValue: eventSink(deps.jobs ?? noJobs, (err) => deps.log.warn({ err: { message: (err as Error).message } }, 'could not queue an event')) },
        { provide: WEBHOOK_GUARD, useValue: deps.webhooks ?? {} },
        { provide: CHANGES, useValue: deps.changes ?? null },
        { provide: VOICE_SAMPLES, useValue: deps.voiceSamples ?? null },
        { provide: MAIL, useValue: deps.mail ?? null },
        { provide: FRONT_DESK, useValue: new FrontDeskRepository(deps.db, deps.cipher, { scan: deps.options.searchScan }) },
        { provide: SCHEDULE, useValue: new ScheduleRepository(deps.db, deps.cipher) },
        { provide: PATIENTS, useValue: new PatientRecords(deps.db, deps.cipher, { scanWindow: deps.options.searchScan ? PATIENT_SCAN_LIMIT : undefined }) },
        { provide: STAFF_SCHEDULER, useValue: new StaffScheduler(deps.db, deps.cipher, deps.now) },
        { provide: CLOCK, useValue: deps.now ?? (() => new Date()) },
        { provide: APP_GUARD, useClass: StaffGuard },
        // after the guards, so a key belongs to the person (or the hosting layer) they let in
        { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
      ],
    };
  }
}

/**
 * The dashboard API, ready to listen. Nest serves /api/v1 (every route behind
 * StaffGuard, except /api/v1/health), Better Auth serves /api/auth, and the
 * OpenAPI document is at /api/docs.
 */
/** The one route that takes a large body. */
export const KNOWLEDGE_UPLOAD_ROUTE = '/api/v1/clinics/:clinicId/knowledge/documents';
/** CSV imports: up to 2 MB of text, as JSON. */
export const IMPORT_ROUTES = ['/api/v1/clinics/:clinicId/doctors/import', '/api/v1/clinics/:clinicId/patients/import'];

/** How long an idle connection stays open after an answer. */
export const KEEP_ALIVE_MS = 72_000;

export async function createApi(deps: ApiDeps): Promise<NestFastifyApplication> {
  const hops = deps.trustProxy ?? 0;
  // trust exactly `hops` proxies (the dashboard), so a client-sent X-Forwarded-For entry never becomes the address
  // keep-alive: a connection stays open 72 s after an answer (Fastify's default, written out so it stays), longer than the
  // dashboard's proxy keeps an idle one, so the next request reuses it and never meets a socket closing under it
  const adapter = new FastifyAdapter({ trustProxy: (_address: string, hop: number) => hop < hops, bodyLimit: 512 * 1024, keepAliveTimeout: KEEP_ALIVE_MS });
  const addressOf = (req: { ip: string; headers: Record<string, string | string[] | undefined> }) => clientAddress(req, !!deps.trustCloudflare);
  // rawBody: a JSON body's bytes as they came stay on the request (req.rawBody), next to the parsed body: a signed
  // provisioning request is checked against them (http/signature.ts), and an idempotency key is tied to them (http/idempotency.ts)
  const app = await NestFactory.create<NestFastifyApplication>(ApiModule.with(deps), adapter, { logger: false, rawBody: true });
  app.setGlobalPrefix('api/v1');
  const fastify = app.getHttpAdapter().getInstance();

  // Documents for the clinic's knowledge arrive as raw bytes, up to 5 MB, on that one
  // route. The parser keeps the server's 512 KB limit, so every other route, Better
  // Auth's included, refuses a large body whatever its content type says.
  fastify.removeContentTypeParser('text/plain');
  fastify.addContentTypeParser(['application/pdf', 'text/plain', 'text/markdown', 'application/octet-stream'], { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  // a person's picture (PUT /me/avatar), checked by its first bytes in the route, within the 512 KB limit
  fastify.addContentTypeParser(['image/webp', 'image/png', 'image/jpeg'], { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  // A DELETE carries no body, but a client may still label it JSON (the hosted setup page did, so
  // removing a vet or a document failed with a 400 that said nothing): no body is read as no body
  fastify.addHook('onRequest', async (req) => {
    if (req.method === 'DELETE' && !Number(req.headers['content-length'] ?? 0) && !req.headers['transfer-encoding']) delete req.headers['content-type'];
  });
  // each request's database time: every query it runs, however deep, adds to the DbTime kept on the request,
  // read back for its Server-Timing header and its log line (counts and times only)
  fastify.addHook('onRequest', (req, _reply, done) => { (req as { dbTime?: DbTime }).dbTime = measureDb(() => done()); });
  fastify.addHook('onRoute', (route) => {
    if (route.url === KNOWLEDGE_UPLOAD_ROUTE && ([] as string[]).concat(route.method).includes('POST')) route.bodyLimit = 5 * 1024 * 1024 + 1024;
    if (IMPORT_ROUTES.includes(route.url) && ([] as string[]).concat(route.method).includes('POST')) route.bodyLimit = 3 * 1024 * 1024;
  });

  // every route, Better Auth's included: sign-in is where guessing happens. Counted per
  // signed-in session, so a team behind one office connection is not one budget; per
  // address for everything without a session (sign-in included)
  const authContext = await deps.auth.$context;
  await fastify.register(rateLimit, {
    max: deps.rateLimit ?? 600, timeWindow: 60_000,
    keyGenerator: rateLimitKey({ cookieName: authContext.authCookies.sessionToken.name, secret: authContext.secret }, addressOf),
  });

  // Method, route and status only. Bodies and query strings can carry PHI.
  const timings = new RouteTimings();
  fastify.addHook('onResponse', async (req, reply) => {
    const ms = Math.round(reply.elapsedTime);
    const db = (req as { dbTime?: DbTime }).dbTime;
    deps.log.info({ method: req.method, route: req.routeOptions.url, status: reply.statusCode, ms, dbMs: db ? Math.round(db.ms) : undefined, queries: db?.queries }, 'request');
    timings.add(`${req.method} ${req.routeOptions.url ?? 'unknown'}`, reply.elapsedTime);
  });
  // p50 and p95 per route, once a minute, so the slow ones show in the logs (counts and times only)
  const report = setInterval(() => {
    const rows = timings.drain();
    if (rows.length) deps.log.info({ routes: rows }, 'route timings');
    const slow = overBudget(rows);
    if (slow.length) deps.log.warn({ routes: slow, budgetMs: ROUTE_P95_BUDGET_MS }, 'routes over budget');
  }, 60_000);
  report.unref();
  fastify.addHook('onClose', async () => clearInterval(report));
  // the server's own time on every answer, for the browser's network panel (the round trip is the rest): app is the
  // whole of it, db the time its queries took (summed: queries run side by side can add up to more than app)
  fastify.addHook('onSend', async (req, reply) => {
    if (!req.url.startsWith('/api/') || reply.sent || reply.raw.headersSent) return;
    const db = (req as { dbTime?: DbTime }).dbTime;
    reply.header('server-timing', serverTiming(reply.elapsedTime, db));
  });
  // Nest turns thrown errors into responses; the server-side ones still need a trace.
  // Name and code only: a database error message can quote the values in a row.
  app.useGlobalFilters({
    catch(err: unknown, host: import('@nestjs/common').ArgumentsHost) {
      const reply = host.switchToHttp().getResponse<import('fastify').FastifyReply>();
      const req = host.switchToHttp().getRequest<import('fastify').FastifyRequest>();
      // an HttpException was thrown on purpose and says what went wrong; anything else is a bug
      const known = typeof (err as { getStatus?: () => number }).getStatus === 'function';
      // a plugin's own 4xx (the rate limiter's 429, a body too large) keeps its status
      const own = (err as { statusCode?: unknown }).statusCode;
      const client = !known && typeof own === 'number' && own >= 400 && own < 500 ? own : null;
      const status = known ? (err as { getStatus: () => number }).getStatus() : client ?? 500;
      if (status >= 500) deps.log.error({ route: req.routeOptions.url, name: (err as Error).name, code: (err as { code?: string }).code }, 'request failed');
      const body = known ? (err as { getResponse: () => unknown }).getResponse()
        : client ? { error: client === 429 ? 'rate_limited' : client === 413 ? 'too_large' : 'bad_request' } : { error: 'server_error' };
      void reply.status(status).send(typeof body === 'string' ? { error: body } : body);
    },
  });
  // Nothing from the API is cached anywhere: responses can hold transcripts and names. The one
  // exception is a teammate's picture, kept privately in the browser for a few minutes (UsersController).
  fastify.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/api/') && !String(reply.getHeader('cache-control') ?? '').startsWith('private,')) reply.header('cache-control', 'no-store');
  });
  // JSON of 1 KB or more goes out compressed (brotli, else gzip) when the browser takes it: the calls list, the
  // schedule and the settings are the big answers, and from far away every kilobyte is time (note 17)
  fastify.addHook('onSend', async (req, reply, payload) => (req.url.startsWith('/api/') ? compressReply(req, reply, payload) : payload));

  fastify.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: async (req, reply) => {
      const url = new URL(req.url, deps.options.publicUrl);
      const route = `${req.method} ${url.pathname.replace(/^\/api\/auth/, '')}`;
      if (!AUTH_ROUTES.has(route)) return reply.status(404).send({ error: 'not_found' });
      let input = (req.body ?? {}) as Record<string, unknown>;
      const headers = toHeaders(req.headers);
      headers.set('x-forwarded-for', addressOf(req));
      const now = deps.now?.() ?? new Date();

      // A temporary password works once, and only for 72 hours. Checked after the password
      // itself, so the answer never tells a stranger that an address has an account.
      const expired = route === 'POST /sign-in/email' && typeof input.email === 'string'
        ? await passwordState(deps.db, { email: input.email }).then((s) => (s?.mustChange && s.expiresAt && s.expiresAt < now ? s.id : null))
        : null;
      // "Forgot password": whose password the link resets, so a temporary one stops being temporary
      let resetting: string | null = null;
      if (route === 'POST /reset-password' && typeof input.token === 'string') resetting = await resetTokenUser(deps.db, input.token);
      // Whoever typed a temporary password must not be able to set up the second step for its owner.
      let changing: string | null = null;
      if (route === 'POST /two-factor/enable' || route === 'POST /change-password') {
        const session = await deps.auth.api.getSession({ headers });
        if (!session) return reply.status(401).send({ error: 'signed_out' });
        const state = await passwordState(deps.db, { userId: session.user.id });
        if (route === 'POST /two-factor/enable' && state?.mustChange) return reply.status(403).send({ error: 'password_change_required', message: 'Choose your own password first.' });
        if (route === 'POST /change-password') {
          if (typeof input.newPassword === 'string' && input.newPassword === input.currentPassword) {
            return reply.status(400).send({ error: 'same_password', message: 'Choose a new password, not the one you were given.' });
          }
          // every other session ends: the one the manager may have opened with the temporary password too
          input = { ...input, revokeOtherSessions: true };
          changing = session.user.id;
        }
      }
      const body = req.method === 'POST' ? JSON.stringify(input) : undefined;
      const res = await deps.auth.handler(new Request(url, { method: req.method, headers, body }));
      if (expired && res.ok) {
        // the right temporary password, but too late: the session it just opened goes again
        await endSessions(deps.db, expired);
        return reply.status(401).send({ error: 'temporary_password_expired', message: 'This temporary password has expired. Ask your practice manager to reset it.' });
      }
      if ((changing || resetting) && res.ok) await clearTemporaryPassword(deps.db, (changing ?? resetting)!);
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

/** The Server-Timing header: the whole time on the server, and the database's share when it was measured. */
export function serverTiming(appMs: number, db?: DbTime): string {
  const app = `app;dur=${appMs.toFixed(1)}`;
  return db && db.queries ? `${app}, db;dur=${db.ms.toFixed(1)};desc="${db.queries} ${db.queries === 1 ? 'query' : 'queries'}"` : app;
}

/**
 * The server's share of a page change (docs/dashboard-speed.md): each route's p95 stays under this. A minute where a
 * route with five answers or more went over it is logged as a warning, by route, counts and times only.
 */
export const ROUTE_P95_BUDGET_MS = 200;
/** The routes over budget in one window; the change and live streams stay open by design and are left out. */
export const overBudget = (rows: { route: string; count: number; p95: number }[]) =>
  rows.filter((r) => r.count >= 5 && r.p95 > ROUTE_P95_BUDGET_MS && !/\/(changes|calls\/:callId\/live)$/.test(r.route));

/** Response times per route in a window: p50 and p95, then reset. */
export class RouteTimings {
  private readonly seen = new Map<string, number[]>();
  add(route: string, ms: number) {
    const list = this.seen.get(route) ?? [];
    if (list.length < 5000) list.push(ms);
    this.seen.set(route, list);
  }
  drain(): { route: string; count: number; p50: number; p95: number }[] {
    const out = [...this.seen].map(([route, list]) => {
      const sorted = [...list].sort((a, b) => a - b);
      const at = (q: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!);
      return { route, count: sorted.length, p50: at(0.5), p95: at(0.95) };
    });
    this.seen.clear();
    return out.sort((a, b) => b.p95 - a.p95);
  }
}
