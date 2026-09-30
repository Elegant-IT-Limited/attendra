import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config';

const base = { DATABASE_URL: 'postgres://a:b@localhost:5432/c', ATTENDRA_DATA_KEY: 'x'.repeat(44) };

describe('MCP environment', () => {
  it('takes a port from 1 to 65535, and a blank one as the default', () => {
    expect(loadEnv({ ...base, MCP_PORT: '' }).MCP_PORT).toBe(8082);
    expect(() => loadEnv({ ...base, MCP_PORT: '0' })).toThrow('MCP_PORT');
    expect(() => loadEnv({ ...base, MCP_PORT: '65536' })).toThrow('MCP_PORT');
  });
});
