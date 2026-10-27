import { DEMO_CLINIC } from '@attendra/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi } from './helpers';

// "Added by Ana Front (Front desk)": who wrote a request down, never their email
const C = `/api/v1/clinics/${DEMO_CLINIC.id}`;
let api: Awaited<ReturnType<typeof startApi>>;
let as: Record<'owner' | 'staff', string>;
beforeAll(async () => {
  api = await startApi({ demoMode: false, twoFactor: 'optional' });
  as = { owner: await api.signIn('omar@maple.example'), staff: await api.signIn('ana@maple.example') };
});
afterAll(() => api.close());

type View = { id: string; callId: string | null; details: Record<string, string>; createdBy: { name: string | null; role: string | null; avatarUrl: string | null } | null };
const tasks = async () => (await api.request('GET', `${C}/tasks`, { cookie: as.owner })).json().tasks as View[];

describe('a request says who made it', () => {
  it('carries createdBy with the name, the role here and the picture for a request added by hand, and null for the assistant\'s', async () => {
    const res = await api.request('POST', `${C}/tasks`, { cookie: as.staff, body: { type: 'callback', name: 'Dana Whitfield', reason: 'Asked about a dental cleaning', callbackNumber: '505-555-0142' } });
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    const list = await tasks();
    const mine = list.find((t) => t.id === id)!;
    expect(mine.createdBy).toEqual({ name: 'Ana Front', role: 'staff', avatarUrl: null });
    // the name typed is the request's title when no record is linked
    expect(mine.details).toMatchObject({ name: 'Dana Whitfield', callback_number: '505-555-0142' });
    expect(list.find((t) => t.id === api.taskId)).toMatchObject({ callId: api.callId, createdBy: null });

    // with a picture, its address comes along
    const picture = await api.request('PUT', '/api/v1/me/avatar', { cookie: as.staff, raw: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), headers: { 'content-type': 'image/jpeg' } });
    expect((await tasks()).find((t) => t.id === id)!.createdBy!.avatarUrl).toBe(picture.json().avatarUrl);

    // no email anywhere in a request's view
    const body = (await api.request('GET', `${C}/tasks`, { cookie: as.owner })).body;
    expect(body).not.toContain('ana@maple.example');
  });

  it('someone no longer on the team is not named: name and role are null, and so is the picture', async () => {
    expect((await api.request('DELETE', `${C}/members/${api.users.staff}`, { cookie: as.owner })).statusCode).toBe(204);
    const byHand = (await tasks()).filter((t) => !t.callId);
    expect(byHand.map((t) => t.createdBy)).toEqual([{ name: null, role: null, avatarUrl: null }]);
  });

  it('the name typed is kept to 80 characters', async () => {
    const res = await api.request('POST', `${C}/tasks`, { cookie: as.owner, body: { type: 'callback', name: 'x'.repeat(81), reason: 'A long name' } });
    expect([res.statusCode, res.json().issues[0].path]).toEqual([422, 'name']);
  });
});
