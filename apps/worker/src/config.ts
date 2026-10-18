// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

const blank = (v: unknown) => (v === '' ? undefined : v);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blank, schema.optional());

/** Validated once at boot. Without an OpenAI key the worker summarises from the call's facts alone. */
const Env = z.object({
  DATABASE_URL: z.string().url(),
  ATTENDRA_DATA_KEY: z.string().min(40, 'ATTENDRA_DATA_KEY must be 32 random bytes, base64'),
  OPENAI_API_KEY: optional(z.string().min(1)),
  ATTENDRA_SUMMARY_MODEL: z.preprocess(blank, z.string().default('gpt-6-luna')),
  ATTENDRA_EMBEDDING_MODEL: z.preprocess(blank, z.string().default('text-embedding-3-small')),
  // where Twilio reports delivery of texts: the voice service's public address
  ATTENDRA_VOICE_PUBLIC_URL: optional(z.string().url()),
  ATTENDRA_SMS_DAILY_CAP: z.preprocess(blank, z.coerce.number().int().min(1).max(100_000).default(500)),
  // texts the team's decisions (a refill ready to pick up); without both, nothing is texted
  TWILIO_ACCOUNT_SID: optional(z.string().startsWith('AC').min(10)),
  TWILIO_AUTH_TOKEN: optional(z.string().min(1)),
  LOG_LEVEL: z.preprocess(blank, z.string().default('info')),
});
export type Env = z.infer<typeof Env>;

export function loadEnv(source = process.env): Env {
  const parsed = Env.safeParse(source);
  if (!parsed.success) throw new Error(`invalid environment: ${parsed.error.issues.map((i) => `${i.path.join('.')} (${i.message})`).join(', ')}`);
  return parsed.data;
}
