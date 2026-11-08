import { describe, expect, it } from 'vitest';
import { BUILT_IN_VOICES, ClinicConfig, DEFAULT_VOICE, DEMO_CLINIC, REALTIME_VOICES, VOICE_CANDIDATES, voiceLabel } from '../src';

describe('voices', () => {
  it('offers the built-in voices by name, with the default marked', () => {
    expect(BUILT_IN_VOICES).toContain('marin');
    expect(BUILT_IN_VOICES).toHaveLength(23);
    expect(voiceLabel('marin')).toBe('Marin (the default)');
    expect(voiceLabel('cedar')).toBe('Cedar');
  });

  it('still loads a configuration saved with any voice name', () => {
    expect(ClinicConfig.parse({ ...DEMO_CLINIC, voice: 'a-custom-voice' }).voice).toBe('a-custom-voice');
    expect(ClinicConfig.parse({ ...DEMO_CLINIC, voice: undefined }).voice).toBe('marin');
  });

  it('offers voices to try by ear that gpt-realtime speaks, each once, none of them the default, each with its reason (note 18)', () => {
    const names = VOICE_CANDIDATES.map((c) => c.voice);
    expect(names.length).toBeGreaterThanOrEqual(2);
    expect(names.length).toBeLessThanOrEqual(3);
    expect(new Set(names).size).toBe(names.length);
    for (const c of VOICE_CANDIDATES) {
      expect(REALTIME_VOICES).toContain(c.voice);
      expect(c.voice).not.toBe(DEFAULT_VOICE);
      expect(c.why.length).toBeGreaterThan(20);
    }
    expect(REALTIME_VOICES).toContain(DEFAULT_VOICE);
  });
});
