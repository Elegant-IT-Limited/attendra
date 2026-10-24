import { starterClinic } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assignNumber, clinicForNumber, createOrganizationWithClinic, phoneUsage, releaseNumber } from '../src';
import { openTestDatabase } from '../src/testing';

let t: Awaited<ReturnType<typeof openTestDatabase>>;
beforeAll(async () => { t = await openTestDatabase(); });
afterAll(() => t.close());

describe('provisioning', () => {
  it('opens an organization with its clinic, without pointing the clinic\'s own number at it', async () => {
    const config = starterClinic({ id: 'clinic_oak', name: 'Oak Hill Vets', timezone: 'America/Chicago', industry: 'vet', phone: '+13125550100' });
    await createOrganizationWithClinic(t.db, { id: 'org_oak', name: 'Oak Hill Vets', plan: 'trial' }, config);
    expect(await clinicForNumber(t.db, '+13125550100')).toBeNull();
    await expect(createOrganizationWithClinic(t.db, { id: 'org_oak', name: 'Again', plan: 'trial' }, { ...config, id: 'clinic_oak_2' })).rejects.toThrow();
    expect((await t.db.execute(sql`select count(*)::int as n from clinics where id = 'clinic_oak_2'`)).rows[0]).toEqual({ n: 0 });
  });

  it('points a number at a clinic, first in its numbers, moves it from another clinic, and releases it', async () => {
    expect(await assignNumber(t.db, 'clinic_oak', '+13125550199')).toBe(true);
    expect(await clinicForNumber(t.db, '+13125550199')).toMatchObject({ id: 'clinic_oak', phoneNumbers: ['+13125550199', '+13125550100'] });
    const config = starterClinic({ id: 'clinic_elm', name: 'Elm Vets', timezone: 'America/Chicago', industry: 'vet', phone: '+13125550200' });
    await createOrganizationWithClinic(t.db, { id: 'org_elm', name: 'Elm Vets', plan: 'trial' }, config);
    expect(await assignNumber(t.db, 'clinic_elm', '+13125550199')).toBe(true);
    expect(await clinicForNumber(t.db, '+13125550199')).toMatchObject({ id: 'clinic_elm' });
    const [oak] = (await t.db.execute(sql`select config->'phoneNumbers' as n from clinics where id = 'clinic_oak'`)).rows as [{ n: string[] }];
    expect(oak.n).toEqual(['+13125550100']);
    expect(await assignNumber(t.db, 'clinic_none', '+13125550198')).toBe(false);
    await expect(assignNumber(t.db, 'clinic_elm', '3125550198')).rejects.toThrow('E.164');
    expect(await releaseNumber(t.db, '+13125550199')).toBe(true);
    expect(await clinicForNumber(t.db, '+13125550199')).toBeNull();
  });

  it('counts phone minutes start to end, leaving out browser tests and calls still going on', async () => {
    const at = (iso: string, secs: number, channel = 'phone', ended = true) => t.db.execute(sql`insert into calls (clinic_id, openai_session_id, started_at, ended_at, channel)
      values ('clinic_oak', ${`s_${Math.random()}`}, ${iso}::timestamptz, ${ended ? new Date(Date.parse(iso) + secs * 1000).toISOString() : null}::timestamptz, ${channel})`);
    await at('2026-09-01T15:00:00Z', 90.4);
    await at('2026-09-02T15:00:00Z', 30);
    await at('2026-09-02T16:00:00Z', 300, 'web');
    await at('2026-09-03T16:00:00Z', 60, 'phone', false);
    await at('2026-10-01T15:00:00Z', 60);
    expect(await phoneUsage(t.db, 'clinic_oak', new Date('2026-09-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'))).toEqual({ calls: 2, seconds: 121, texts: 0 });
  });

  it('counts the texts the carrier took in the period, never one refused before sending', async () => {
    const text = (key: string, sid: string | null, sentAt: string | null) => t.db.execute(sql`insert into sms_messages (clinic_id, template, to_hash, status, idempotency_key, provider_sid, sent_at)
      values ('clinic_oak', 'booking_confirmed', 'h', ${sid ? 'sent' : 'not_sent'}, ${key}, ${sid}, ${sentAt}::timestamptz)`);
    await text('a', 'SM1', '2026-09-05T15:00:00Z');
    await text('b', 'SM2', '2026-09-30T23:59:00Z');
    await text('c', null, null);
    await text('d', 'SM3', '2026-10-01T00:00:00Z');
    expect((await phoneUsage(t.db, 'clinic_oak', new Date('2026-09-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'))).texts).toBe(2);
  });
});
