// SPDX-License-Identifier: AGPL-3.0-only
import { ClinicConfig, DEMO_CLINIC } from '@attendra/core';
import { schema } from '@attendra/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startApi } from './helpers';

// Note 46: a location on Vapi chooses its ElevenLabs voice in Settings > Voice; only a listed voice is saved, always on
// eleven_flash_v2_5, and the rest of its Vapi link stays the operator's.
const C = `/api/v1/clinics/${DEMO_CLINIC.id}/settings`;
let api: Awaited<ReturnType<typeof startApi>>;
let owner: string;
beforeAll(async () => {
  api = await startApi({ demoMode: false, twoFactor: 'optional' });
  owner = await api.signIn('omar@maple.example', true);
  const [row] = await api.t.db.select({ config: schema.clinics.config }).from(schema.clinics).where(eq(schema.clinics.id, DEMO_CLINIC.id));
  const onVapi = { ...ClinicConfig.parse(row!.config), voiceEngine: 'vapi' as const, vapi: { assistantId: 'asst_1', phoneNumberId: 'pn_1', overflowEngine: 'gpt-realtime' as const } };
  await api.t.owner.update(schema.clinics).set({ config: onVapi }).where(eq(schema.clinics.id, DEMO_CLINIC.id));
});
afterAll(() => api.close());

const save = async (vapi: unknown) => {
  const read = await api.request('GET', C, { cookie: owner });
  return api.request('PUT', C, { cookie: owner, body: { ...(read.json() as object), vapi }, headers: { 'if-match': read.headers.etag as string } });
};
const stored = async () => ClinicConfig.parse((await api.t.db.select({ config: schema.clinics.config }).from(schema.clinics).where(eq(schema.clinics.id, DEMO_CLINIC.id)))[0]!.config).vapi;

it('saves a listed ElevenLabs voice on its model, and keeps the Vapi ids and the engine as they were', async () => {
  const res = await save({ assistantId: 'asst_forged', voice: { provider: '11labs', voiceId: 'XrExE9yKIg1WjnnlVkGX', model: 'eleven_multilingual_v2' } });
  expect(res.statusCode).toBe(200);
  expect(await stored()).toEqual({ assistantId: 'asst_1', phoneNumberId: 'pn_1', overflowEngine: 'gpt-realtime', voice: { provider: '11labs', voiceId: 'XrExE9yKIg1WjnnlVkGX', model: 'eleven_flash_v2_5' } });
  expect((res.json() as ClinicConfig).voiceEngine).toBe('vapi');
});

it('keeps the saved voice when the one sent is not listed, or is Vapi\'s own', async () => {
  for (const voice of [{ provider: '11labs', voiceId: 'someone-else' }, { provider: 'vapi', voiceId: 'Elliot' }]) {
    expect((await save({ voice })).statusCode).toBe(200);
    expect((await stored())?.voice?.voiceId).toBe('XrExE9yKIg1WjnnlVkGX');
  }
});
