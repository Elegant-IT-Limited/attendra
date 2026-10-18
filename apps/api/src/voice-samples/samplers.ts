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
 * OpenAI's side. The session has client delegation, like a call, so it cannot take
 * response.create: the model starts speaking from its instructions, as it greets a
 * caller, and is nudged once with speakable commentary if it has not begun after
 * `nudgeMs`. The speech ends when no audio has come for `quietMs`.
 */
export function liveSample(open: () => LiveSocket, model: string, voice: string, text: string, opts: { quietMs?: number; timeoutMs?: number; nudgeMs?: number } = {}): Promise<Buffer> {
  const ws = open();
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    let quiet: ReturnType<typeof setTimeout> | undefined;
    let nudge: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(overall); clearTimeout(quiet); clearTimeout(nudge);
      try { ws.close(); } catch { /* already closed */ }
      if (err) reject(err);
      else if (!chunks.length) reject(new Error('no audio'));
      else resolve(wav(Buffer.concat(chunks)));
    };
    const overall = setTimeout(() => (chunks.length ? finish() : finish(new Error('timed out'))), opts.timeoutMs ?? 20_000);
    ws.on('event', (e) => {
      if (e.type === 'session.started') {
        nudge = setTimeout(() => {
          if (!chunks.length) ws.send({ type: 'session.commentary.append', delegation_id: null, content: `Say exactly this now, once: ${text}` });
        }, opts.nudgeMs ?? 2500);
      } else if (e.type === 'session.output_audio.delta') {
        clearTimeout(nudge);
        chunks.push(Buffer.from(e.delta, 'base64'));
        clearTimeout(quiet);
        quiet = setTimeout(() => finish(), opts.quietMs ?? 1500);
      } else if (e.type === 'error') {
        // OpenAI's message says which field it refused; it never holds patient data here
        const err = (e as { error?: { code?: string; message?: string } }).error;
        finish(new Error(`live error: ${err?.code ?? 'unknown'}${err?.message ? `: ${err.message}` : ''}`));
      }
      else if (e.type === 'session.closed') finish();
    });
    ws.on('error', (err) => finish(err));
    ws.send({
      type: 'session.start',
      session: {
        model, store: false,
        // the same opening a call uses (voice-engine prompt.ts), with nothing after it
        instructions: `You are reading a short voice preview. Start with exactly this greeting: "${text}" Say it once, in a warm and natural phone voice, then stop and say nothing else.`,
        audio: { format: { type: 'audio/pcm', rate: RATE }, output: { voice } },
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
