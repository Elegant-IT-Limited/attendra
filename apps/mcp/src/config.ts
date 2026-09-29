// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

const blank = (v: unknown) => (v === '' ? undefined : v);
const Env = z.object({
  DATABASE_URL: z.string().url(),
  ATTENDRA_DATA_KEY: z.string().min(40, 'ATTENDRA_DATA_KEY must be 32 random bytes, base64'),
  // stdio only: the key the local MCP client runs with
  ATTENDRA_API_KEY: z.preprocess(blank, z.string().optional()),
  MCP_PORT: z.preprocess(blank, z.coerce.number().int().default(8082)),
  LOG_LEVEL: z.preprocess(blank, z.string().default('info')),
});
export type Env = z.infer<typeof Env>;

export function loadEnv(source = process.env): Env {
  const parsed = Env.safeParse(source);
  if (!parsed.success) throw new Error(`invalid environment: ${parsed.error.issues.map((i) => `${i.path.join('.')} (${i.message})`).join(', ')}`);
  return parsed.data;
}
