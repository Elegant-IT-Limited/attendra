// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

const blank = (v: unknown) => (v === '' ? undefined : v);
const LOG_LEVEL = z.preprocess(blank, z.string().default('info'));
const Env = z.object({
  DATABASE_URL: z.string().url(),
  ATTENDRA_DATA_KEY: z.string().min(40, 'ATTENDRA_DATA_KEY must be 32 random bytes, base64'),
  MCP_PORT: z.preprocess(blank, z.coerce.number().int().default(8082)),
  LOG_LEVEL,
});
export type Env = z.infer<typeof Env>;

/** The stdio bridge: where the clinic's /mcp server is, and the key. Nothing else. */
const BridgeEnv = z.object({
  ATTENDRA_MCP_URL: z.string().url().refine((u) => /^https:\/\//.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(u), 'ATTENDRA_MCP_URL must be https (or http on this machine)'),
  ATTENDRA_API_KEY: z.string().regex(/^atk_[A-Za-z0-9_-]{43}$/, 'ATTENDRA_API_KEY must be an Attendra API key (atk_...): make one in Settings > API keys'),
  LOG_LEVEL,
});
export type BridgeEnv = z.infer<typeof BridgeEnv>;

const parse = <T extends z.ZodType>(schema: T, source: Record<string, unknown>): z.infer<T> => {
  const parsed = schema.safeParse(source);
  if (!parsed.success) throw new Error(`invalid environment: ${parsed.error.issues.map((i) => `${i.path.join('.')} (${i.message})`).join(', ')}`);
  return parsed.data;
};
export const loadEnv = (source: Record<string, unknown> = process.env): Env => parse(Env, source);
export const loadBridgeEnv = (source: Record<string, unknown> = process.env): BridgeEnv => parse(BridgeEnv, source);
