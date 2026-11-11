// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { REALTIME_VOICES, VAPI_VOICES, vapiTestCallLine, vapiVoiceFor, vapiVoiceOf, VapiVoiceChoice } from '../src';

// Note 46: Vapi speaks with an ElevenLabs voice (eleven_flash_v2_5), of the same kind as the clinic's own voice, never
// Vapi's own "Elliot"; a location's own choice wins.
describe('the voice on Vapi', () => {
  it('is an ElevenLabs voice of the clinic\'s own voice\'s kind', () => {
    expect(vapiVoiceFor('marin')).toEqual({ provider: '11labs', voiceId: 'EXAVITQu4vr4xnSDxMaL', model: 'eleven_flash_v2_5' });
    expect(vapiVoiceFor('cedar').voiceId).toBe('iP95p4xoKVk53GoZ742B');
    expect(vapiVoiceFor(undefined).voiceId).toBe('EXAVITQu4vr4xnSDxMaL');
    for (const v of REALTIME_VOICES) expect(VapiVoiceChoice.parse(vapiVoiceFor(v)).provider).toBe('11labs');
  });
  it('keeps the location\'s own choice', () => {
    const own = { provider: '11labs' as const, voiceId: 'XrExE9yKIg1WjnnlVkGX', model: 'eleven_flash_v2_5' as const };
    expect(vapiVoiceOf({ voice: 'cedar', vapi: { voice: own } })).toEqual(own);
    expect(vapiVoiceOf({ voice: 'cedar' }).voiceId).toBe('iP95p4xoKVk53GoZ742B');
  });
  it('offers three female voices and one male, each a valid choice, with a preview from ElevenLabs where known', () => {
    expect(VAPI_VOICES.filter((v) => v.kind === 'female')).toHaveLength(3);
    expect(VAPI_VOICES.filter((v) => v.kind === 'male')).toHaveLength(1);
    for (const v of VAPI_VOICES) {
      expect(VapiVoiceChoice.safeParse({ provider: '11labs', voiceId: v.voiceId, model: 'eleven_flash_v2_5' }).success).toBe(true);
      if (v.preview) expect(v.preview).toMatch(/^https:\/\/storage\.googleapis\.com\/eleven-public-prod\/premade\/voices\/[A-Za-z0-9]+\/[0-9a-f-]+\.mp3$/);
    }
  });
  it('the test-call page says how to hear Vapi', () => {
    expect(vapiTestCallLine('(516) 555-0123')).toBe("This test call uses Attendra's engine. To hear Vapi, call (516) 555-0123.");
    expect(vapiTestCallLine(null)).toBe("This test call uses Attendra's engine. To hear Vapi, call the location's number.");
  });
});
