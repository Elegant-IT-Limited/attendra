import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config';

const base = { DATABASE_URL: 'postgres://a:b@localhost:5432/c', ATTENDRA_DATA_KEY: 'x'.repeat(44), BETTER_AUTH_SECRET: 'y'.repeat(40) };

describe('API environment', () => {
  it('treats a blank line in .env as unset, and uses the default', () => {
    const env = loadEnv({ ...base, API_PORT: '', LOG_LEVEL: '', ATTENDRA_DEMO_MODE: '', TRUST_PROXY: '', PUBLIC_URL: '' });
    expect(env).toMatchObject({ API_PORT: 8081, LOG_LEVEL: 'info', ATTENDRA_DEMO_MODE: false, TRUST_PROXY: 0, PUBLIC_URL: 'http://localhost:3000' });
  });

  it('refuses a port outside 1 to 65535 and a log level pino does not know', () => {
    expect(() => loadEnv({ ...base, API_PORT: '0' })).toThrow('API_PORT');
    expect(() => loadEnv({ ...base, API_PORT: '70000' })).toThrow('API_PORT');
    expect(() => loadEnv({ ...base, LOG_LEVEL: 'loud' })).toThrow('LOG_LEVEL');
    expect(loadEnv({ ...base, TRUST_PROXY: 'true', ATTENDRA_DEMO_MODE: '1' })).toMatchObject({ TRUST_PROXY: 1, ATTENDRA_DEMO_MODE: true });
  });
});
