// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

// an empty line in .env (VOICE_URL=) means not set
const blank = (v: unknown) => (v === '' ? undefined : v);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blank, schema.optional());
const flag = z.preprocess(blank, z.enum(['true', 'false', '1', '0']).default('false')).transform((v) => v === 'true' || v === '1');
/** A TCP port: a whole number from 1 to 65535. */
export const port = (fallback: number) => z.preprocess(blank, z.coerce.number().int().min(1).max(65535).default(fallback));

/** Validated once at boot, so a missing secret stops the process instead of the first request. */
const Env = z.object({
  API_PORT: port(8081),
  DATABASE_URL: z.string().url(),
  ATTENDRA_DATA_KEY: z.string().min(40, 'ATTENDRA_DATA_KEY must be 32 random bytes, base64'),
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters: openssl rand -base64 32'),
  // The address people open in the browser. The web app proxies /api to this service,
  // so cookies stay first-party and this is also the only origin allowed to write.
  PUBLIC_URL: z.preprocess(blank, z.string().url().default('http://localhost:3000')),
  // Demo mode skips the two-factor requirement so the seeded demo login works in one
  // step. Never set it on a deployment that holds real patient data.
  ATTENDRA_DEMO_MODE: flag,
  // Set when the API sits behind the web app's proxy (docker compose does), so the
  // rate limiter sees each browser's address instead of the proxy's.
  TRUST_PROXY: flag.transform((on) => (on ? 1 : 0)),
  // The voice service, for test calls from the dashboard. Leave both unset to turn them off.
  VOICE_URL: optional(z.string().url()),
  VOICE_INTERNAL_TOKEN: optional(z.string().min(32, 'VOICE_INTERNAL_TOKEN must be at least 32 characters')),
  // The clinic's knowledge: Ask a question embeds the question and answers with a model.
  // Use the same embedding model as the worker. Without a key, both use local embeddings.
  OPENAI_API_KEY: optional(z.string().min(1)),
  ATTENDRA_EMBEDDING_MODEL: z.preprocess(blank, z.string().default('text-embedding-3-small')),
  ATTENDRA_BACKEND_MODEL: z.preprocess(blank, z.string().default('gpt-6-luna')),
  // the text-to-speech model behind Settings' voice samples
  ATTENDRA_TTS_MODEL: z.preprocess(blank, z.string().default('gpt-4o-mini-tts')),
  // Two-step sign-in: required for everyone (the default), or optional, for a hosted service whose
  // accounts hold no patient health information (veterinary clinics). Demo mode skips it either way.
  ATTENDRA_TWO_FACTOR: z.preprocess(blank, z.enum(['required', 'optional']).default('required')),
  // Minutes without activity, in every tab, before the dashboard signs out: 15 where it holds
  // patient records; a hosted service for veterinary clinics can choose longer (up to 12 hours).
  ATTENDRA_IDLE_MINUTES: z.preprocess(blank, z.coerce.number().int().min(5).max(720).default(15)),
  // Turns on /api/v1/provisioning for a hosting layer: opening accounts, numbers, usage. Unset, the routes do not exist.
  ATTENDRA_PROVISIONING_TOKEN: optional(z.string().min(32, 'ATTENDRA_PROVISIONING_TOKEN must be at least 32 characters: openssl rand -base64 32')),
  // Where the hosting layer takes emails the engine cannot send itself ("forgot password"), signed with ATTENDRA_PROVISIONING_TOKEN.
  // Unset, the sign-in page tells people to ask their practice manager for a reset.
  ATTENDRA_MAIL_HOOK_URL: optional(z.url()),
  // Extra links for owners in the dashboard menu, as JSON: [{"label":"Billing","href":"https://billing.example/{clinicId}"}].
  // A hosting layer uses it for billing or setup pages; {clinicId} becomes the clinic's id. Self-hosters leave it unset.
  ATTENDRA_ACCOUNT_LINKS: z.preprocess((v) => (v === '' || v === undefined ? [] : typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return v; } })() : v),
    z.array(z.object({ label: z.string().trim().min(1).max(30), href: z.string().max(300).refine((h) => /^(https:\/\/|\/)/.test(h), 'an account link is an https:// address or a path') })).max(5)),
  LOG_LEVEL: z.preprocess(blank, z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info')),
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
