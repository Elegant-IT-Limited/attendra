import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { connect, connectionRole, logConnectionRole, serviceDatabaseUrl } from '../src';
import { openTestDatabase } from '../src/testing';

describe('the database pool', () => {
  it('reports a dropped connection by its code, without ending the process', async () => {
    const codes: string[] = [];
    const db = connect('postgres://nobody:nothing@127.0.0.1:1/none', { onError: (code) => codes.push(code) });
    const pool = (db as unknown as { $client: Pool }).$client;
    // what node-postgres emits when the server closes an idle connection
    expect(() => pool.emit('error', Object.assign(new Error('terminating connection: row (Maria Delgado)'), { code: '57P01' }))).not.toThrow();
    expect(codes).toEqual(['57P01']);
    await pool.end();
  });
});

describe('which role a service connects as', () => {
  it('uses the services\' URL when the deploy gives one, the owner\'s otherwise', () => {
    const owner = 'postgres://attendra:x@db:5432/attendra';
    const service = 'postgres://attendra_service:y@db:5432/attendra';
    expect(serviceDatabaseUrl({ DATABASE_URL: owner })).toBe(owner);
    expect(serviceDatabaseUrl({ DATABASE_URL: owner, ATTENDRA_SERVICE_DATABASE_URL: service })).toBe(service);
  });

  it('logs attendra_service as held by row-level security, and an error when the services\' URL is a role that is not', async () => {
    const lines: { level: string; o: object; msg: string }[] = [];
    const log = { info: (o: object, msg: string) => lines.push({ level: 'info', o, msg }), error: (o: object, msg: string) => lines.push({ level: 'error', o, msg }) };
    const service = await openTestDatabase({ as: 'service' });
    const owner = await openTestDatabase({ as: 'owner' });
    try {
      expect(await connectionRole(service.db)).toEqual({ role: 'attendra_service', bypassesRls: false });
      expect((await connectionRole(owner.db)).bypassesRls).toBe(true);
      await logConnectionRole(service.db, log, true);
      await logConnectionRole(owner.db, log, true);
      await logConnectionRole(owner.db, log, false);
      expect(lines.map((l) => [l.level, l.o])).toEqual([
        ['info', { role: 'attendra_service', rowLevelSecurity: true }],
        ['error', { role: expect.any(String) }],
        ['info', { role: expect.any(String), rowLevelSecurity: false }],
      ]);
    } finally {
      await service.close();
      await owner.close();
    }
  });
});
