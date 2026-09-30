import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { connect } from '../src';

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
