import { describe, expect, it } from 'vitest';
import { BUILT_IN_VOICES, ClinicConfig, DEMO_CLINIC, voiceLabel } from '../src';

describe('voices', () => {
  it('offers the built-in voices by name, with the default marked', () => {
    expect(BUILT_IN_VOICES).toContain('marin');
    expect(BUILT_IN_VOICES).toHaveLength(22);
    expect(voiceLabel('marin')).toBe('Marin (the default)');
    expect(voiceLabel('cedar')).toBe('Cedar');
  });

  it('still loads a configuration saved with any voice name', () => {
    expect(ClinicConfig.parse({ ...DEMO_CLINIC, voice: 'a-custom-voice' }).voice).toBe('a-custom-voice');
    expect(ClinicConfig.parse({ ...DEMO_CLINIC, voice: undefined }).voice).toBe('marin');
  });
});
