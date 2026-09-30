import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config';

const base = { DATABASE_URL: 'postgres://a:b@localhost:5432/c', ATTENDRA_DATA_KEY: 'x'.repeat(44), OPENAI_API_KEY: 'sk-test' };

describe('voice service environment', () => {
  it('starts with an OpenAI key alone, for test calls', () => {
    const env = loadEnv({ ...base, OPENAI_WEBHOOK_SECRET: '', TWILIO_ACCOUNT_SID: '', TWILIO_AUTH_TOKEN: '', BROWSER_CALL_MAX_SECONDS: '', GPT_LIVE_MODEL: '' });
    expect(env.OPENAI_WEBHOOK_SECRET).toBeUndefined();
    expect(env.TWILIO_ACCOUNT_SID).toBeUndefined();
    expect(env.BROWSER_CALL_MAX_SECONDS).toBe(300);
    expect(env.GPT_LIVE_MODEL).toBe('gpt-live-1');
  });

  it('takes a port from 1 to 65535, and a blank one as the default', () => {
    expect(loadEnv({ ...base, PORT: '' }).PORT).toBe(8080);
    expect(() => loadEnv({ ...base, PORT: '0' })).toThrow('PORT');
    expect(() => loadEnv({ ...base, PORT: '99999' })).toThrow('PORT');
  });

  it('refuses half a Twilio setup and a short internal token', () => {
    expect(() => loadEnv({ ...base, TWILIO_ACCOUNT_SID: 'AC0123456789' })).toThrow('TWILIO');
    expect(() => loadEnv({ ...base, VOICE_INTERNAL_TOKEN: 'short' })).toThrow('VOICE_INTERNAL_TOKEN');
  });
});
