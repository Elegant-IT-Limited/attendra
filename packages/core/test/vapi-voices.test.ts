// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { listedVapiVoice, VAPI_DEFAULT_VOICE_ID, VAPI_VOICES, vapiDefaultVoice, vapiTestCallLine, vapiVoiceOf, VapiVoiceChoice } from '../src';

// Note 46: Vapi speaks with an ElevenLabs voice (eleven_flash_v2_5), never Vapi's own "Elliot"; a location's own choice
// wins. V5 (2026-11-18): until a location chooses, the voice is a man's, the owner's choice.
describe('the voice on Vapi', () => {
  it('is the male ElevenLabs voice until the location chooses one, whatever its own OpenAI voice', () => {
    expect(vapiDefaultVoice()).toEqual({ provider: '11labs', voiceId: 'iP95p4xoKVk53GoZ742B', model: 'eleven_flash_v2_5' });
    expect(listedVapiVoice(VAPI_DEFAULT_VOICE_ID)).toMatchObject({ name: 'Chris', kind: 'male' });
    // marin is every clinic's starting voice: it no longer means a woman's voice on Vapi
    expect(vapiVoiceOf({}).voiceId).toBe(VAPI_DEFAULT_VOICE_ID);
    expect(VapiVoiceChoice.parse(vapiDefaultVoice()).provider).toBe('11labs');
  });
  it('keeps the location\'s own choice', () => {
    const own = { provider: '11labs' as const, voiceId: 'XrExE9yKIg1WjnnlVkGX', model: 'eleven_flash_v2_5' as const };
    expect(vapiVoiceOf({ vapi: { voice: own } })).toEqual(own);
    expect(vapiVoiceOf({ voice: 'cedar', vapi: { voice: own } })).toEqual(own);
    expect(vapiVoiceOf({ vapi: {} }).voiceId).toBe(VAPI_DEFAULT_VOICE_ID);
  });
  it('keeps the kind of a voice the clinic picked itself; the starting voice, marin, is no choice (the owner\'s rule, 2026-11-19)', () => {
    const sarah = VAPI_VOICES.find((v) => v.name === 'Sarah')!.voiceId;
    expect(vapiVoiceOf({ voice: 'coral' }).voiceId).toBe(sarah);
    expect(vapiVoiceOf({ voice: 'shimmer' }).voiceId).toBe(sarah);
    expect(vapiVoiceOf({ voice: 'cedar' }).voiceId).toBe(VAPI_DEFAULT_VOICE_ID);
    expect(vapiVoiceOf({ voice: 'marin' }).voiceId).toBe(VAPI_DEFAULT_VOICE_ID);
    // a voice of another kind of engine, or one not known: the default
    expect(vapiVoiceOf({ voice: 'unknown-voice' }).voiceId).toBe(VAPI_DEFAULT_VOICE_ID);
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
