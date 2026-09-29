// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/** A contract schema as an OpenAPI schema object, for @ApiOkResponse and friends. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const schemaOf = (s: z.ZodType): any => z.toJSONSchema(s, { target: 'openapi-3.0', io: 'output', unrepresentable: 'any' });
