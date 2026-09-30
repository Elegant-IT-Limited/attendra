// SPDX-License-Identifier: AGPL-3.0-only
import { type PipeTransform, UnprocessableEntityException } from '@nestjs/common';
import type { z } from 'zod';

export const issuesOf = (error: z.ZodError) => error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));

/**
 * Validates a query or body against its contract schema; the handler only sees parsed
 * values. A request that fails is 422 invalid_request, the same status and code as a
 * request a handler refuses on its own rules, so a client checks one of each.
 */
export class ZodPipe<S extends z.ZodType> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) throw new UnprocessableEntityException({ error: 'invalid_request', issues: issuesOf(parsed.error) });
    return parsed.data;
  }
}
