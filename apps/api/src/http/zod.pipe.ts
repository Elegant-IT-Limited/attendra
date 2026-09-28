// SPDX-License-Identifier: AGPL-3.0-only
import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

export const issuesOf = (error: z.ZodError) => error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));

/** Validates a query or body against its contract schema; the handler only sees parsed values. */
export class ZodPipe<S extends z.ZodType> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) throw new BadRequestException({ error: 'invalid_request', issues: issuesOf(parsed.error) });
    return parsed.data;
  }
}
