// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/** Validated once at boot, so a missing secret stops the process instead of the first call. */
const Env = z.object({
  PORT: z.coerce.number().int().default(8080),
  DATABASE_URL: z.string().url(),
  ATTENDRA_DATA_KEY: z.string().min(40, 'ATTENDRA_DATA_KEY must be 32 random bytes, base64'),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_WEBHOOK_SECRET: z.string().startsWith('whsec_'),
  GPT_LIVE_MODEL: z.string().default('gpt-live-1'),
  ATTENDRA_BACKEND_MODEL: z.string().default('gpt-6-luna'),
  TWILIO_ACCOUNT_SID: z.string().startsWith('AC'),
  TWILIO_AUTH_TOKEN: z.string().min(1),
  LOG_LEVEL: z.string().default('info'),
});
export type Env = z.infer<typeof Env>;

export function loadEnv(source = process.env): Env {
  const parsed = Env.safeParse(source);
  if (!parsed.success) {
    throw new Error(`invalid environment: ${parsed.error.issues.map((i) => `${i.path.join('.')} (${i.message})`).join(', ')}`);
  }
  return parsed.data;
}
