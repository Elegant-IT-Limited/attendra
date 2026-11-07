import { DEMO_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHANGE_CHANNEL, createPhiCipher, Fanout, inviteToTeam, notifyChange, type Notice, REPLAY_MS, seedDemo } from '../src';
import { openTestDatabase, TEST_DATA_KEY } from '../src/testing';

/**
 * The change notices (migrations 0021, 0046, 0048) and what the API does with them: one
 * clinic's notices reach that clinic's streams only, a person's reach that person only,
 * and a browser that comes back is told what it missed in the last minute, or everything
 * when that cannot be told. Made-up people.
 */
const note = (o: object) => JSON.stringify(o);

describe('the fan-out', () => {
  it('sends a clinic\'s notices to that clinic, and a person\'s to that person, never across', () => {
    const f = new Fanout();
    const got: Record<string, string[]> = { a: [], b: [], kim: [], lee: [] };
    f.subscribe({ clinicId: 'clinic_a', userId: 'u_kim' }, (n) => got.a!.push(n.topic));
    f.subscribe({ clinicId: 'clinic_b', userId: 'u_lee' }, (n) => got.b!.push(n.topic));
    f.subscribe({ userId: 'u_kim' }, (n) => got.kim!.push(n.topic));
    f.subscribe({ userId: 'u_lee' }, (n) => got.lee!.push(n.topic));
    f.deliver(note({ clinic: 'clinic_a', topic: 'requests' }));
    f.deliver(note({ user: 'u_kim', topic: 'me' }));
    f.deliver(note({ clinic: 'clinic_b', topic: 'live' }));
    // 'me' is about a person, never a clinic; a person's notice is 'me' only; junk is dropped
    f.deliver(note({ clinic: 'clinic_a', topic: 'me' }));
    f.deliver(note({ user: 'u_kim', topic: 'requests' }));
    f.deliver(note({ clinic: 'clinic_a', topic: 'passwords' }));
    f.deliver('not json');
    expect(got).toEqual({ a: ['requests', 'me'], b: ['live'], kim: ['me'], lee: [] });
  });

  it('numbers every notice, and a reconnect is told what it missed in the last minute', () => {
    let now = 1_000_000;
    const f = new Fanout(() => now);
    const scope = { clinicId: 'clinic_a', userId: 'u_kim' };
    // a first connection: no id, nothing to replay
    expect(f.since(scope, null)).toBeNull();
    expect(f.since(scope, 'not-an-id')).toBeNull();
    const before = f.cursor();
    f.deliver(note({ clinic: 'clinic_a', topic: 'requests' }));
    f.deliver(note({ clinic: 'clinic_b', topic: 'schedule' }));
    f.deliver(note({ user: 'u_kim', topic: 'me' }));
    f.deliver(note({ clinic: 'clinic_a', topic: 'requests' }));
    expect([...(f.since(scope, before) as string[])].sort()).toEqual(['me', 'requests']);
    // up to date: nothing
    expect(f.since(scope, f.cursor())).toBeNull();
    // only what came after the id
    const mid = f.cursor();
    f.deliver(note({ clinic: 'clinic_a', topic: 'settings' }));
    expect(f.since(scope, mid)).toEqual(['settings']);
    // older than the minute kept: the gap cannot be told
    now += REPLAY_MS + 1;
    f.deliver(note({ clinic: 'clinic_a', topic: 'calls' }));
    expect(f.since(scope, mid)).toBe('*');
    // another process's id (the API restarted), or one from the future
    expect(f.since(scope, 'deadbeef.1')).toBe('*');
    expect(f.since(scope, f.cursor(10_000))).toBe('*');
  });

  it('notices lost while LISTEN was down: every stream, open or coming back, reads everything', () => {
    const f = new Fanout();
    const seen: Notice[] = [];
    f.subscribe({ clinicId: 'clinic_a', userId: 'u_kim' }, (n) => seen.push(n));
    const before = f.cursor();
    f.lost();
    expect(seen.map((n) => n.topic)).toEqual(['*']);
    expect(f.since({ clinicId: 'clinic_z', userId: 'u_lee' }, before)).toBe('*');
  });

  it('stops sending to a stream that closed', () => {
    const f = new Fanout();
    const seen: string[] = [];
    const stop = f.subscribe({ clinicId: 'clinic_a', userId: 'u_kim' }, (n) => seen.push(n.topic));
    stop();
    f.deliver(note({ clinic: 'clinic_a', topic: 'requests' }));
    f.deliver(note({ user: 'u_kim', topic: 'me' }));
    expect(seen).toEqual([]);
  });
});

describe('the notices Postgres sends (0048)', () => {
  let t: Awaited<ReturnType<typeof openTestDatabase>>;
  const heard: { clinic?: string; user?: string; topic: string }[] = [];
  beforeAll(async () => {
    t = await openTestDatabase();
    await seedDemo(t.db, createPhiCipher(TEST_DATA_KEY));
    for (const [id, email] of [['u_owner', 'owner@maple.example'], ['u_kim', 'Kim@Elsewhere.example']] as const) {
      await t.owner.execute(sql`insert into auth_users (id, name, email, email_verified) values (${id}, ${id}, ${email}, true)`);
    }
    await t.owner.execute(sql`insert into memberships (id, organization_id, user_id, role) values ('m_owner', 'org_demo', 'u_owner', 'owner')`);
    await t.client.listen(CHANGE_CHANNEL, (p) => heard.push(JSON.parse(p)));
  });
  afterAll(() => t.close());
  const after = async (write: () => Promise<unknown>) => {
    heard.length = 0;
    await write();
    // PGlite delivers a notice on the next turn after the commit
    await new Promise((r) => setTimeout(r, 50));
    return [...heard];
  };

  it('an invitation tells the login with that address (any case), and the location\'s team', async () => {
    const got = await after(() => inviteToTeam(t.db, DEMO_CLINIC.id, { userId: 'u_owner', role: 'owner' }, { email: 'kim@elsewhere.example', role: 'staff' }));
    expect(got).toContainEqual({ user: 'u_kim', topic: 'me' });
    expect(got).toContainEqual({ clinic: DEMO_CLINIC.id, topic: 'team' });
    // never the address or the role
    expect(JSON.stringify(got)).not.toMatch(/elsewhere|staff/);
  });

  it('an address with no login yet tells nobody but the location', async () => {
    const got = await after(() => inviteToTeam(t.db, DEMO_CLINIC.id, { userId: 'u_owner', role: 'owner' }, { email: 'new@elsewhere.example', role: 'staff' }));
    expect(got.filter((n) => n.user)).toEqual([]);
  });

  it('a role given, changed or removed at a location tells the person', async () => {
    expect(await after(() => t.owner.execute(sql`insert into clinic_memberships (id, clinic_id, user_id, role) values ('cm_kim', ${DEMO_CLINIC.id}, 'u_kim', 'staff')`))).toContainEqual({ user: 'u_kim', topic: 'me' });
    expect(await after(() => t.owner.execute(sql`update clinic_memberships set role = 'viewer' where id = 'cm_kim'`))).toContainEqual({ user: 'u_kim', topic: 'me' });
    expect(await after(() => t.owner.execute(sql`delete from clinic_memberships where id = 'cm_kim'`))).toContainEqual({ user: 'u_kim', topic: 'me' });
    // an owner row too
    expect(await after(() => t.owner.execute(sql`update memberships set approves_refills = true where id = 'm_owner'`))).toContainEqual({ user: 'u_owner', topic: 'me' });
  });

  it('a knowledge document and a text say so, by clinic only', async () => {
    const got = await after(() => t.owner.execute(sql`insert into knowledge_documents (clinic_id, title, source_type, content, content_hash, size_bytes, uploaded_by_user_id)
      values (${DEMO_CLINIC.id}, 'Price list', 'text', 'abc'::bytea, 'h', 3, 'u_owner')`));
    expect(got).toEqual([{ clinic: DEMO_CLINIC.id, topic: 'knowledge' }]);
    const texts = await after(() => t.owner.execute(sql`insert into sms_messages (clinic_id, template, to_hash, idempotency_key) values (${DEMO_CLINIC.id}, 'booked', 'h', 'k1')`));
    expect(texts).toEqual([{ clinic: DEMO_CLINIC.id, topic: 'texts' }]);
  });

  it('the voice service\'s live calls say so from code', async () => {
    expect(await after(() => notifyChange(t.db, DEMO_CLINIC.id, 'live'))).toEqual([{ clinic: DEMO_CLINIC.id, topic: 'live' }]);
  });
});
