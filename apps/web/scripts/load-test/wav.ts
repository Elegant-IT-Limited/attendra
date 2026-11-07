// SPDX-License-Identifier: AGPL-3.0-only

/** 16-bit PCM audio as Chromium's fake microphone reads it from a file. */
export interface Pcm { sampleRate: number; channels: number; data: Buffer }

/** Reads a 16-bit PCM WAV, skipping any chunk that is not `fmt ` or `data` (afconvert and ffmpeg each add their own). */
export function readWav(file: Buffer): Pcm {
  if (file.toString('ascii', 0, 4) !== 'RIFF' || file.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let fmt: Buffer | null = null;
  let data: Buffer | null = null;
  for (let i = 12; i + 8 <= file.length;) {
    const id = file.toString('ascii', i, i + 4);
    const size = file.readUInt32LE(i + 4);
    const body = file.subarray(i + 8, i + 8 + size);
    if (id === 'fmt ') fmt = body;
    if (id === 'data') data = body;
    i += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('a WAV file needs fmt and data chunks');
  if (fmt.readUInt16LE(0) !== 1 || fmt.readUInt16LE(14) !== 16) throw new Error('only 16-bit PCM WAV files');
  return { sampleRate: fmt.readUInt32LE(4), channels: fmt.readUInt16LE(2), data };
}

export function writeWav(pcm: Pcm): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.data.length, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(pcm.channels, 22);
  header.writeUInt32LE(pcm.sampleRate, 24);
  header.writeUInt32LE(pcm.sampleRate * pcm.channels * 2, 28);
  header.writeUInt16LE(pcm.channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.data.length, 40);
  return Buffer.concat([header, pcm.data]);
}

/**
 * One caller's side of a call as a single file: a short silence (the greeting), then each line followed by `gapMs` of
 * silence for the assistant to answer in. Chromium plays the file in a loop, so a call that outlasts it hears the
 * caller start again, which is still load. All lines must share one format.
 */
export function conversation(lines: Pcm[], gapMs: number, leadMs = gapMs): Buffer {
  if (!lines.length) throw new Error('a conversation needs at least one line');
  const { sampleRate, channels } = lines[0]!;
  if (lines.some((l) => l.sampleRate !== sampleRate || l.channels !== channels)) throw new Error('every line must have the same sample rate and channels');
  const silence = (ms: number) => Buffer.alloc(Math.round((ms / 1000) * sampleRate) * channels * 2);
  return writeWav({ sampleRate, channels, data: Buffer.concat([silence(leadMs), ...lines.flatMap((l) => [l.data, silence(gapMs)])]) });
}
