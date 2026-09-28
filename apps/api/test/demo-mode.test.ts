import { DEMO_CLINIC } from '@attendra/core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startApi } from './helpers';

let api: Awaited<ReturnType<typeof startApi>>;
beforeAll(async () => { api = await startApi({ demoMode: true }); });
afterAll(() => api.close());

it('in demo mode a password alone opens the dashboard, and the API says so', async () => {
  const cookie = await api.signIn('ana@maple.example');
  expect((await api.request('GET', `/api/v1/clinics/${DEMO_CLINIC.id}/calls`, { cookie })).statusCode).toBe(200);
  expect((await api.request('GET', '/api/v1/me', { cookie })).json().demoMode).toBe(true);
});

it('in demo mode nobody can point transfers somewhere new', async () => {
  const cookie = await api.signIn('olga@maple.example');
  const res = await api.request('PUT', `/api/v1/clinics/${DEMO_CLINIC.id}/settings`, {
    cookie, body: { ...DEMO_CLINIC, routing: [{ target: 'on_call', uri: 'tel:+19005550100', when: 'always', priority: 0 }] },
  });
  expect(res.statusCode).toBe(422);
  expect(res.json().issues[0].path).toBe('routing');
});
