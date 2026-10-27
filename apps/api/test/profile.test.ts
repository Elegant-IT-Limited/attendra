import { DEMO_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MailRequest } from '../src/mail-hook';
import { OTHER, startApi } from './helpers';

// Your profile: your own name, your picture, served only to people you work with
const C = `/api/v1/clinics/${DEMO_CLINIC.id}`;
const mails: MailRequest[] = [];
let now = new Date('2026-11-08T15:00:00Z');
let api: Awaited<ReturnType<typeof startApi>>;
let as: Record<'owner' | 'admin' | 'staff' | 'outsider', string>;
beforeAll(async () => {
  api = await startApi({ demoMode: false, twoFactor: 'optional', mails, now: () => now });
  as = {
    owner: await api.signIn('omar@maple.example'),
    admin: await api.signIn('olga@maple.example'),
    staff: await api.signIn('ana@maple.example'),
    outsider: await api.signIn('otto@other.example'),
  };
});
afterAll(() => api.close());

const me = async (cookie: string) => (await api.request('GET', '/api/v1/me', { cookie })).json().user as { id: string; name: string; email: string; avatarUrl: string | null };
const put = (cookie: string, raw: Buffer, type: string) => api.request('PUT', '/api/v1/me/avatar', { cookie, raw, headers: { 'content-type': type } });
const picture = (cookie: string, url: string, headers: Record<string, string> = {}) => api.request('GET', url, { cookie, headers });
// made-up images: only their first bytes say what they are, which is all the API reads
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x40, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(48, 2)]);

describe('your name', () => {
  it('you change your own name, 2 to 80 characters, audited in each of your clinics with neither name in the row', async () => {
    const res = await api.request('PATCH', '/api/v1/me', { cookie: as.staff, body: { name: '  Ana Rivera  ' } });
    expect(res.statusCode).toBe(204);
    expect((await me(as.staff)).name).toBe('Ana Rivera');
    // the team sees it at once
    const team = (await api.request('GET', `${C}/members`, { cookie: as.owner })).json().members as { userId: string; name: string }[];
    expect(team.find((m) => m.userId === api.users.staff)?.name).toBe('Ana Rivera');
    const rows = (await api.t.db.execute(sql`select clinic_id, actor, entity, entity_id, counts from audit_logs where action = 'user.name.changed'`)).rows as { clinic_id: string }[];
    const clinics = ((await api.t.db.execute(sql`select id from clinics where org_id = 'org_demo' order by id`)).rows as { id: string }[]).map((r) => r.id);
    expect(rows.map((r) => r.clinic_id).sort()).toEqual(clinics);
    expect(rows[0]).toMatchObject({ actor: `user:${api.users.staff}`, entity: 'member', entity_id: api.users.staff, counts: null });
    expect(JSON.stringify(rows)).not.toMatch(/Ana|Rivera|Front/);
    // another organization's log has nothing about it
    expect((await api.t.db.execute(sql`select 1 from audit_logs where action = 'user.name.changed' and clinic_id = ${OTHER.id}`)).rows).toEqual([]);
  });

  it('refuses a name under 2 or over 80 characters, and never renames anyone else', async () => {
    for (const name of ['A', ' ', 'x'.repeat(81)]) {
      const res = await api.request('PATCH', '/api/v1/me', { cookie: as.staff, body: { name } });
      expect([res.statusCode, res.json().issues[0].path]).toEqual([422, 'name']);
    }
    // only the body's name is read: a user id in it changes nothing about that person
    expect((await api.request('PATCH', '/api/v1/me', { cookie: as.admin, body: { name: 'Olga Admin', userId: api.users.owner } })).statusCode).toBe(204);
    expect((await me(as.owner)).name).toBe('Omar Owner');
    expect((await me(as.staff)).name).toBe('Ana Rivera');
  });
});

describe('your picture', () => {
  it('/me carries avatarUrl, null until there is a picture', async () => {
    expect((await me(as.admin)).avatarUrl).toBeNull();
  });

  it('upload, replace and delete; the address changes with each picture', async () => {
    const first = await put(as.admin, PNG, 'image/png');
    expect(first.statusCode).toBe(200);
    const url = first.json().avatarUrl as string;
    expect(url).toBe(`/api/v1/users/${api.users.admin}/avatar?v=${now.getTime()}`);
    expect((await me(as.admin)).avatarUrl).toBe(url);

    const own = await picture(as.admin, url);
    expect(own.statusCode).toBe(200);
    expect(own.headers['content-type']).toBe('image/png');
    expect(own.headers['cache-control']).toBe('private, max-age=300');
    expect(own.headers.etag).toBe(`"a${now.getTime()}"`);
    expect(own.rawPayload.equals(PNG)).toBe(true);
    // the browser asks again with its copy's version: nothing to send
    expect((await picture(as.admin, url, { 'if-none-match': own.headers.etag as string })).statusCode).toBe(304);

    // a teammate sees it, in Team, in Assign to and on the picture's own address
    expect((await picture(as.staff, url)).statusCode).toBe(200);
    const team = (await api.request('GET', `${C}/members`, { cookie: as.owner })).json().members as { userId: string; avatarUrl: string | null }[];
    expect(team.find((m) => m.userId === api.users.admin)?.avatarUrl).toBe(url);
    expect(team.find((m) => m.userId === api.users.owner)?.avatarUrl).toBeNull();
    const people = (await api.request('GET', `${C}/tasks/assignees`, { cookie: as.owner })).json().people as { userId: string; avatarUrl: string | null }[];
    expect(people.find((p) => p.userId === api.users.admin)?.avatarUrl).toBe(url);

    // replaced: a new version, a new address, the new type
    now = new Date(now.getTime() + 60_000);
    const second = await put(as.admin, WEBP, 'image/webp');
    expect(second.statusCode).toBe(200);
    expect(second.json().avatarUrl).not.toBe(url);
    const replaced = await picture(as.admin, second.json().avatarUrl);
    expect([replaced.headers['content-type'], replaced.rawPayload.equals(WEBP)]).toEqual(['image/webp', true]);

    expect((await api.request('DELETE', '/api/v1/me/avatar', { cookie: as.admin })).statusCode).toBe(204);
    expect((await me(as.admin)).avatarUrl).toBeNull();
    expect((await picture(as.admin, url)).statusCode).toBe(404);
    expect((await api.t.db.execute(sql`select 1 from user_avatars where user_id = ${api.users.admin}`)).rows).toEqual([]);
  });

  it('refuses what is not an image, whatever its content-type says, and anything over 200 KB', async () => {
    const text = await put(as.staff, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/png');
    expect([text.statusCode, text.json().error]).toEqual([415, 'not_an_image']);
    const json = await api.request('PUT', '/api/v1/me/avatar', { cookie: as.staff, body: { image: 'x' } });
    expect(json.statusCode).toBe(415);
    const big = await put(as.staff, Buffer.concat([PNG, Buffer.alloc(200 * 1024)]), 'image/png');
    expect([big.statusCode, big.json().error]).toEqual([413, 'too_large']);
    expect((await me(as.staff)).avatarUrl).toBeNull();
  });

  it('another organization\'s person gets 404 for it, the same as for no picture at all', async () => {
    const url = (await put(as.staff, PNG, 'image/png')).json().avatarUrl as string;
    const stranger = await picture(as.outsider, url);
    expect([stranger.statusCode, stranger.json()]).toEqual([404, { error: 'not_found' }]);
    expect(stranger.headers['cache-control']).toBe('no-store');
    expect((await picture(as.outsider, `/api/v1/users/${api.users.owner}/avatar`)).statusCode).toBe(404);
    expect((await picture('', url)).statusCode).toBe(401);
  });

  it('a note on a request carries its author\'s picture', async () => {
    const url = (await me(as.staff)).avatarUrl;
    expect(url).not.toBeNull();
    expect((await api.request('POST', `${C}/tasks/${api.taskId}/notes`, { cookie: as.staff, body: { body: 'Left a message.' } })).statusCode).toBe(204);
    const task = ((await api.request('GET', `${C}/tasks`, { cookie: as.staff })).json().tasks as { id: string; notes: { author: string; authorAvatarUrl: string | null }[] }[])
      .find((t) => t.id === api.taskId)!;
    expect(task.notes.at(-1)).toMatchObject({ author: 'Ana Rivera', authorAvatarUrl: url });
  });
});

describe('the invitation email', () => {
  it('greets by the name typed in Add people, as typed, and with no name says only "Hi,"', async () => {
    await api.request('POST', `${C}/members`, { cookie: as.owner, body: { email: 'Kit.Morales@maple.example', role: 'staff' } });
    await api.request('POST', `${C}/members`, { cookie: as.owner, body: { name: 'dana MacLeod', email: 'dana@maple.example', role: 'staff' } });
    const sent = mails.filter((m) => m.type === 'team_invitation').map((m) => [m.email, m.name]);
    expect(sent).toEqual([['kit.morales@maple.example', ''], ['dana@maple.example', 'dana MacLeod']]);
  });
});
