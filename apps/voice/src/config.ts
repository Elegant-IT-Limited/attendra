// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

// an empty line in .env (TWILIO_AUTH_TOKEN=) means not set
const blank = (v: unknown) => (v === '' ? undefined : v);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blank, schema.optional());

/** Validated once at boot, so a missing secret stops the process instead of the first call. */
const Env = z.object({
  PORT: z.preprocess(blank, z.coerce.number().int().min(1).max(65535).default(8080)),
  DATABASE_URL: z.string().url(),
  ATTENDRA_DATA_KEY: z.string().min(40, 'ATTENDRA_DATA_KEY must be 32 random bytes, base64'),
  OPENAI_API_KEY: z.string().min(1),
  // phone calls need the webhook secret, texts need Twilio; browser test calls need neither
  OPENAI_WEBHOOK_SECRET: optional(z.string().startsWith('whsec_').min(10)),
  GPT_LIVE_MODEL: z.preprocess(blank, z.string().default('gpt-live-1')),
  // the second engine, OpenAI's Realtime API, and which engine answers a clinic the operator has not given one
  ATTENDRA_REALTIME_MODEL: z.preprocess(blank, z.string().default('gpt-realtime-2.1')),
  ATTENDRA_VOICE_ENGINE: z.preprocess(blank, z.enum(['gpt-live', 'gpt-realtime']).default('gpt-live')),
  ATTENDRA_BACKEND_MODEL: z.preprocess(blank, z.string().default('gpt-6-luna')),
  ATTENDRA_EMBEDDING_MODEL: z.preprocess(blank, z.string().default('text-embedding-3-small')),
  TWILIO_ACCOUNT_SID: optional(z.string().startsWith('AC').min(10)),
  TWILIO_AUTH_TOKEN: optional(z.string().min(1)),
  // this service's public https address: Twilio sends text replies (STOP) and delivery reports to it
  ATTENDRA_VOICE_PUBLIC_URL: optional(z.string().url()),
  ATTENDRA_SMS_DAILY_CAP: z.preprocess(blank, z.coerce.number().int().min(1).max(100_000).default(150)),
  ATTENDRA_SMS_MONTHLY_CAP: z.preprocess(blank, z.coerce.number().int().min(1).max(1_000_000).default(2000)),
  VOICE_INTERNAL_TOKEN: optional(z.string().min(32, 'VOICE_INTERNAL_TOKEN must be at least 32 characters')),
  BROWSER_CALL_MAX_SECONDS: z.preprocess(blank, z.coerce.number().int().min(30).max(1800).default(300)),
  // where alerts go: a Slack incoming webhook for the people who run Attendra; without it they are only logged
  ATTENDRA_SLACK_WEBHOOK_URL: optional(z.string().url().startsWith('https://hooks.slack.com/')),
  LOG_LEVEL: z.preprocess(blank, z.string().default('info')),
});
export type Env = z.infer<typeof Env>;

export function loadEnv(source = process.env): Env {
  const parsed = Env.safeParse(source);
  if (!parsed.success) {
    throw new Error(`invalid environment: ${parsed.error.issues.map((i) => `${i.path.join('.')} (${i.message})`).join(', ')}`);
  }
  if (!parsed.data.TWILIO_ACCOUNT_SID !== !parsed.data.TWILIO_AUTH_TOKEN) throw new Error('invalid environment: set both TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN, or neither');
  return parsed.data;
}
