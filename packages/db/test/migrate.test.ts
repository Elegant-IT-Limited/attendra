import { PGlite } from '@electric-sql/pglite';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src';

describe('migrate', () => {
  it('rolls a failed file back, and leaves the connection usable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'attendra-migrate-'));
    writeFileSync(join(dir, '0001_ok.sql'), 'create table a (id int);');
    writeFileSync(join(dir, '0002_bad.sql'), 'create table b (id int); select 1 / 0;');
    const client = new PGlite();
    await expect(migrate(client, dir)).rejects.toThrow(/division by zero/);
    expect((await client.query(`select to_regclass('b') as b`)).rows).toEqual([{ b: null }]);
    expect((await client.query('select id from schema_migrations')).rows).toEqual([{ id: '0001_ok.sql' }]);
    await client.close();
  });
});
