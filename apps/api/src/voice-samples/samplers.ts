// SPDX-License-Identifier: AGPL-3.0-only
import type OpenAI from 'openai';
import type { ClientEvent, ServerEvent } from 'openai/resources/live/live';
import { LiveWS } from 'openai/resources/live/ws';
import type { VoiceSampler } from '../http/tokens';

/** The voices the speech model also has: their sample comes from it, quickly, as MP3. */
export const TTS_VOICES = new Set(['alloy', 'ash', 'ballad', 'cedar', 'coral', 'echo', 'marin', 'sage', 'shimmer', 'verse']);

const RATE = 24_000;

/** What the sampler needs from a Live WebSocket; tests pass a fake. */
export interface LiveSocket {
  send(event: ClientEvent): void;
  on(event: 'event', handler: (e: ServerEvent) => void): unknown;
  on(event: 'error', handler: (err: Error) => void): unknown;
  close(): void;
}

/** Mono 16-bit PCM wrapped as a WAV file, so a browser plays it as it is. */
export function wav(pcm: Buffer, rate = RATE): Buffer {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

/**
 * The greeting spoken by the Live model itself, in a voice only it has: one short
 * session over a WebSocket that reads the text and is closed. Nothing is stored on
 * OpenAI's side. The speech ends when no audio has come for `quietMs`.
 */
export function liveSample(open: () => LiveSocket, model: string, voice: string, text: string, opts: { quietMs?: number; timeoutMs?: number } = {}): Promise<Buffer> {
  const ws = open();
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    let quiet: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(overall); clearTimeout(quiet);
      try { ws.close(); } catch { /* already closed */ }
      if (err) reject(err);
      else if (!chunks.length) reject(new Error('no audio'));
      else resolve(wav(Buffer.concat(chunks)));
    };
    const overall = setTimeout(() => (chunks.length ? finish() : finish(new Error('timed out'))), opts.timeoutMs ?? 20_000);
    ws.on('event', (e) => {
      if (e.type === 'session.started') ws.send({ type: 'response.create' });
      else if (e.type === 'session.output_audio.delta') {
        chunks.push(Buffer.from(e.delta, 'base64'));
        clearTimeout(quiet);
        quiet = setTimeout(() => finish(), opts.quietMs ?? 1500);
      } else if (e.type === 'error') finish(new Error(`live error: ${(e as { error?: { code?: string } }).error?.code ?? 'unknown'}`));
      else if (e.type === 'session.closed') finish();
    });
    ws.on('error', (err) => finish(err));
    ws.send({
      type: 'session.start',
      session: {
        model, store: false,
        instructions: 'You read text aloud for a voice preview. Say the developer\'s text exactly as written, once, in a warm and natural phone voice, and nothing else.',
        audio: { format: { type: 'audio/pcm', rate: RATE }, output: { voice } },
        input: [{ role: 'developer', content: [{ type: 'input_text', text }] }],
      },
    });
  });
}

/**
 * Samples from OpenAI: the speech model for the voices it has, the Live model for the
 * rest, so every voice on the phone can be heard before it is chosen.
 */
export function openAiVoiceSampler(openai: OpenAI, models: { tts: string; live: string }, open: () => LiveSocket = () => new LiveWS(openai) as unknown as LiveSocket): VoiceSampler {
  return {
    async sample(voice, text) {
      if (TTS_VOICES.has(voice)) {
        return Buffer.from(await (await openai.audio.speech.create({ model: models.tts, voice, input: text, response_format: 'mp3' })).arrayBuffer());
      }
      return liveSample(open, models.live, voice, text);
    },
  };
}
