// SPDX-License-Identifier: AGPL-3.0-only
import { hasPreview } from '@attendra/core';
import type OpenAI from 'openai';
import type { VoiceSampler } from '../http/tokens';

/** A voice only the Live model has: it is heard in a test call, not in a preview. */
export class CallsOnlyVoice extends Error {
  constructor(voice: string) { super(`${voice} is only on calls`); }
}

/** Samples from OpenAI's speech model, for the voices it has (PREVIEW_VOICES). */
export function openAiVoiceSampler(openai: OpenAI, model: string): VoiceSampler {
  return {
    async sample(voice, text) {
      if (!hasPreview(voice)) throw new CallsOnlyVoice(voice);
      return Buffer.from(await (await openai.audio.speech.create({ model, voice, input: text, response_format: 'mp3' })).arrayBuffer());
    },
  };
}
