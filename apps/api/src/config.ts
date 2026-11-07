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
  // the services' own role (migration 0051, docs/self-hosting.md): its queries never get past row-level
  // security. Unset, they run on DATABASE_URL, the owner's, as before. pg-boss stays on DATABASE_URL.
  ATTENDRA_SERVICE_DATABASE_URL: optional(z.string().url()),
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
  // Set when the edge proxy in front of the dashboard sits behind Cloudflare: a request that reached it
  // from one of Cloudflare's addresses (src/http/cloudflare-ips.ts) is counted as the address in its
  // CF-Connecting-IP. From any other address the header is ignored. Needs TRUST_PROXY.
  TRUST_CLOUDFLARE: flag,
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
  // 'require': a provisioning request must be signed with the token (attendra-timestamp + attendra-signature), and the
  // bearer token alone is refused, so the token itself never travels. 'accept' (default): either, while the hosting layer moves over.
  ATTENDRA_PROVISIONING_SIGNATURES: z.preprocess(blank, z.enum(['accept', 'require']).default('accept')),
  // Where the hosting layer takes emails the engine cannot send itself ("forgot password"), signed with ATTENDRA_PROVISIONING_TOKEN.
  // Unset, the sign-in page tells people to ask their practice manager for a reset.
  ATTENDRA_MAIL_HOOK_URL: optional(z.url()),
  // Extra links for owners in the dashboard menu, as JSON: [{"label":"Billing","href":"https://billing.example/{clinicId}"}].
  // A hosting layer uses it for billing or setup pages; {clinicId} becomes the clinic's id. Self-hosters leave it unset.
  // This deployment's MCP server for other AI agents (apps/mcp), as clients reach it, like
  // https://app.example.com/mcp. Settings > API keys shows it next to the keys. Unset, it shows none.
  ATTENDRA_MCP_URL: optional(z.url().refine((u) => /^https:\/\//.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(u), 'ATTENDRA_MCP_URL must be https (or http on this machine)')),
  ATTENDRA_ACCOUNT_LINKS: z.preprocess((v) => (v === '' || v === undefined ? [] : typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return v; } })() : v),
    z.array(z.object({ label: z.string().trim().min(1).max(30), href: z.string().max(300).refine((h) => /^(https:\/\/|\/)/.test(h), 'an account link is an https:// address or a path') })).max(5)),
  // Where the API says it has lost the change notices (LISTEN down for more than 10 s), like the voice service and the worker.
  ATTENDRA_SLACK_WEBHOOK_URL: optional(z.string().url().startsWith('https://hooks.slack.com/')),
  // The way back for one release (v0.10): searches also read and match the newest 20,000 patients and the newest 5,000
  // calls' numbers on every keystroke, as before the search keys. Off by default; turn it on only if a search misses records.
  ATTENDRA_SEARCH_SCAN: flag,
  LOG_LEVEL: z.preprocess(blank, z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info')),
});
export type ApiEnv = z.infer<typeof Env>;

export function loadEnv(source = process.env): ApiEnv {
  const parsed = Env.safeParse(source);
  if (!parsed.success) {
    throw new Error(`invalid environment: ${parsed.error.issues.map((i) => `${i.path.join('.')} (${i.message})`).join(', ')}`);
  }
  if (parsed.data.TRUST_CLOUDFLARE && !parsed.data.TRUST_PROXY) throw new Error('invalid environment: TRUST_CLOUDFLARE needs TRUST_PROXY=true (the edge proxy is the hop that is checked)');
  if (!parsed.data.VOICE_URL !== !parsed.data.VOICE_INTERNAL_TOKEN) throw new Error('invalid environment: set both VOICE_URL and VOICE_INTERNAL_TOKEN, or neither');
  return parsed.data;
}
