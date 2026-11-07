// SPDX-License-Identifier: AGPL-3.0-only
import { claimIdempotencyKey, type Database, finishIdempotencyKey, type PhiCipher, pruneIdempotencyKeys, releaseIdempotencyKey } from '@attendra/db';
import { type CallHandler, type ExecutionContext, HttpException, Inject, Injectable, type NestInterceptor } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { catchError, from, mergeMap, type Observable, of, throwError } from 'rxjs';
import type { Staff } from './staff.guard';
import { CIPHER, CLOCK, DB } from './tokens';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
/** Said on an answer sent again for a key already answered. */
export const REPLAYED_HEADER = 'idempotent-replayed';
/** What a key may look like: a UUID fits, and so does any client's own scheme of letters, digits and -_:. */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_\-:.]{8,128}$/;
const PRUNE_EVERY_MS = 10 * 60_000;

/**
 * Every POST to /api/v1 may carry `Idempotency-Key`. The first request with a key is
 * answered and its answer kept (encrypted: it can name a patient); the same request sent
 * again with the same key gets that answer back, with `Idempotent-Replayed: true`, and
 * nothing is done twice. The same key with another body is refused (422), and a key whose
 * first request is still running answers 409. A request that fails frees its key, so the
 * retry runs. Keys are per person (or per hosting layer) and per path.
 *
 * The dashboard and the hosting layer send a key with every POST. It stays optional for
 * other clients, and the routes that keep their own key in the body (a request, a booking)
 * still do.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private prunedAt = 0;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CIPHER) private readonly cipher: PhiCipher,
    @Inject(CLOCK) private readonly now: () => Date,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<FastifyRequest & { staff?: Staff; rawBody?: Buffer }>();
    if (req.method !== 'POST') return next.handle();
    const key = req.headers[IDEMPOTENCY_HEADER];
    if (key === undefined) return next.handle();
    if (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key)) {
      return throwError(() => new HttpException({ error: 'invalid_idempotency_key', message: 'Idempotency-Key is 8 to 128 letters, digits or -_:.' }, 400));
    }
    const path = req.url.split('?')[0]!;
    const who = req.staff ? `user:${req.staff.userId}` : path.startsWith('/api/v1/provisioning/') ? 'provisioning' : null;
    // a POST nobody signed in for (there is none today) is never kept: it has no owner to keep it for
    if (!who) return next.handle();
    const scope = `${who} POST ${path}`;
    const hash = requestHash(req);
    const reply = http.getResponse<FastifyReply>();
    const status = this.reflector.get<number | undefined>(HTTP_CODE_METADATA, ctx.getHandler()) ?? 201;
    const context = `idempotency:${scope}:${key}`;
    this.prune();

    return from(claimIdempotencyKey(this.db, scope, key, hash, this.now())).pipe(mergeMap((claim) => {
      if (claim.kind === 'mismatch') throw new HttpException({ error: 'idempotency_key_reused', message: 'This Idempotency-Key was used for a different request.' }, 422);
      if (claim.kind === 'in_progress') throw new HttpException({ error: 'idempotency_in_progress', message: 'The first request with this Idempotency-Key is still being answered. Try again in a moment.' }, 409);
      if (claim.kind === 'replay') {
        reply.header(REPLAYED_HEADER, 'true');
        return of(claim.response === null ? undefined : JSON.parse(this.cipher.decrypt(claim.response, context)) as unknown);
      }
      return next.handle().pipe(
        mergeMap(async (body) => {
          // a route that wrote its own answer (none is a POST today) has nothing here to keep
          if (reply.sent) await releaseIdempotencyKey(this.db, scope, key);
          else await finishIdempotencyKey(this.db, scope, key, status, body === undefined ? null : this.cipher.encrypt(JSON.stringify(body), context));
          return body;
        }),
        catchError((err: unknown) => from(releaseIdempotencyKey(this.db, scope, key)).pipe(mergeMap(() => throwError(() => err)))),
      );
    }));
  }

  /** Old answers go now and then, from whichever request comes; a failure is no one's problem. */
  private prune() {
    const now = this.now().getTime();
    if (now - this.prunedAt < PRUNE_EVERY_MS) return;
    this.prunedAt = now;
    void pruneIdempotencyKeys(this.db, this.now()).catch(() => {});
  }
}

/** The request a key is tied to: its path and the bytes of its body, as they came. */
export function requestHash(req: Pick<FastifyRequest, 'url' | 'body'> & { rawBody?: Buffer }): string {
  const hash = createHash('sha256').update(`POST ${req.url}\n`);
  if (req.rawBody) hash.update(req.rawBody);
  else if (Buffer.isBuffer(req.body)) hash.update(req.body);
  else if (req.body !== undefined) hash.update(JSON.stringify(req.body));
  return hash.digest('hex');
}
