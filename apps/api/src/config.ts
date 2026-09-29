// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

const flag = z.enum(['true', 'false', '1', '0']).default('false').transform((v) => v === 'true' || v === '1');

// an empty line in .env (VOICE_URL=) means not set
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

/** Validated once at boot, so a missing secret stops the process instead of the first request. */
const Env = z.object({
  API_PORT: z.coerce.number().int().default(8081),
  DATABASE_URL: z.string().url(),
  ATTENDRA_DATA_KEY: z.string().min(40, 'ATTENDRA_DATA_KEY must be 32 random bytes, base64'),
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters: openssl rand -base64 32'),
  // The address people open in the browser. The web app proxies /api to this service,
  // so cookies stay first-party and this is also the only origin allowed to write.
  PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  // Demo mode skips the two-factor requirement so the seeded demo login works in one
  // step. Never set it on a deployment that holds real patient data.
  ATTENDRA_DEMO_MODE: flag,
  // Set when the API sits behind the web app's proxy (docker compose does), so the
  // rate limiter sees each browser's address instead of the proxy's.
  TRUST_PROXY: flag.transform((on) => (on ? 1 : 0)),
  // The voice service, for test calls from the dashboard. Leave both unset to turn them off.
  VOICE_URL: optional(z.string().url()),
  VOICE_INTERNAL_TOKEN: optional(z.string().min(32, 'VOICE_INTERNAL_TOKEN must be at least 32 characters')),
  LOG_LEVEL: z.string().default('info'),
});
export type ApiEnv = z.infer<typeof Env>;

export function loadEnv(source = process.env): ApiEnv {
  const parsed = Env.safeParse(source);
  if (!parsed.success) {
    throw new Error(`invalid environment: ${parsed.error.issues.map((i) => `${i.path.join('.')} (${i.message})`).join(', ')}`);
  }
  if (!parsed.data.VOICE_URL !== !parsed.data.VOICE_INTERNAL_TOKEN) throw new Error('invalid environment: set both VOICE_URL and VOICE_INTERNAL_TOKEN, or neither');
  return parsed.data;
}
