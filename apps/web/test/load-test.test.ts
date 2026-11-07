import { OPENING_NUDGE_MS, SILENCE_NUDGE_MS } from '@attendra/voice-engine';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cookiesFor, parseOptions, sessions } from '../scripts/load-test/options';
import { bytes, callStatsCommand, parseCallStats, parseDockerStats, parseHost } from '../scripts/load-test/remote';
import { type CallAttempt, markdown, type MeasuredCall, type Run, summarise } from '../scripts/load-test/report';
import { holdStream, splitEvents } from '../scripts/load-test/streams';
import { THRESHOLDS } from '../scripts/load-test/thresholds';
import { conversation, readWav, writeWav } from '../scripts/load-test/wav';

/** The launch load test's parts with no browser and no server of ours: options, audio, the stream holder, the parsers and the verdict. */
const audio = fileURLToPath(new URL('../scripts/load-test/audio', import.meta.url));

describe('options', () => {
  it('takes the plan from the flags, clinics as a list, and defaults to the launch plan', () => {
    const o = parseOptions(['--', '--base', 'https://staging.example.com/', '--clinic', 'clinic_a,clinic_b', '--clinic', 'clinic_c', '--spend']);
    expect(o).toMatchObject({ base: 'https://staging.example.com', clinics: ['clinic_a', 'clinic_b', 'clinic_c'], calls: 20, streams: 10, minutes: 15, spend: true, ssh: null, dryRun: false });
    expect(parseOptions(['--base', 'https://s.example.com', '--ssh', 'staging', '--ssh-port', '22022']).ssh).toEqual({ host: 'staging', port: 22022, sampleSeconds: 10, apiContainer: 'attendra-api-1' });
  });

  it('a dry run is one call, one stream and one minute, on this machine only', () => {
    expect(parseOptions(['--dry-run', '--base', 'http://localhost:23000', '--calls', '20'])).toMatchObject({ calls: 1, streams: 1, minutes: 1, dryRun: true });
    expect(() => parseOptions(['--dry-run', '--base', 'https://staging.example.com'])).toThrow(/this machine only/);
  });

  it('refuses what it does not know, and numbers that are not numbers', () => {
    expect(() => parseOptions(['--base', 'https://s.example.com', '--calls', 'many'])).toThrow(/--calls/);
    expect(() => parseOptions(['--base', 'https://s.example.com', '--cals', '3'])).toThrow(/unknown option --cals/);
    expect(() => parseOptions(['--clinic', 'clinic_a'])).toThrow(/--base is required/);
  });

  it('reads one session a line, and hands a browser the cookies of a Cookie header', () => {
    expect(sessions('Cookie: a=1; b=2\n\n c=3 \n')).toEqual(['a=1; b=2', 'c=3']);
    expect(sessions(undefined)).toEqual([]);
    expect(cookiesFor('__Secure-better-auth.session_token=abc.def%3D; other=x=y', 'https://s.example.com')).toEqual([
      { name: '__Secure-better-auth.session_token', value: 'abc.def%3D', url: 'https://s.example.com', secure: true, httpOnly: true, sameSite: 'Lax' },
      { name: 'other', value: 'x=y', url: 'https://s.example.com', secure: true, httpOnly: true, sameSite: 'Lax' },
    ]);
  });
});

describe('audio', () => {
  it('every committed line is a short 16 kHz mono WAV, one per line of lines.json', () => {
    const lines = JSON.parse(readFileSync(join(audio, 'lines.json'), 'utf8')) as Record<string, string[]>;
    for (const [name, list] of Object.entries(lines)) {
      list.forEach((_, i) => {
        const pcm = readWav(readFileSync(join(audio, `${name}-${i + 1}.wav`)));
        expect(pcm).toMatchObject({ sampleRate: 16_000, channels: 1 });
        expect(pcm.data.length / 32_000).toBeLessThan(8); // seconds
      });
    }
  });

  it('a caller\'s conversation is a lead-in silence, then each line and the gap after it, in one file', () => {
    const line = { sampleRate: 16_000, channels: 1, data: Buffer.alloc(3200, 1) }; // 0.1 s of a non-zero sample
    const out = readWav(conversation([line, line], 500, 250));
    expect(out.sampleRate).toBe(16_000);
    expect(out.data.length).toBe(8000 + 3200 + 16_000 + 3200 + 16_000); // bytes: 0.25 s, 0.1 s, 0.5 s, 0.1 s, 0.5 s
    expect(out.data.subarray(0, 8000).every((b) => b === 0)).toBe(true);
    expect(out.data.subarray(8000, 11_200).every((b) => b === 1)).toBe(true);
    expect(() => conversation([line, { ...line, sampleRate: 8000 }], 500)).toThrow(/same sample rate/);
  });

  it('skips chunks other than fmt and data, and refuses what is not 16-bit PCM', () => {
    const plain = writeWav({ sampleRate: 16_000, channels: 1, data: Buffer.from([1, 2, 3, 4]) });
    const filler = Buffer.concat([Buffer.from('FLLR'), Buffer.from([4, 0, 0, 0]), Buffer.alloc(4)]);
    const padded = Buffer.concat([plain.subarray(0, 36), filler, plain.subarray(36)]);
    expect(readWav(padded).data).toEqual(Buffer.from([1, 2, 3, 4]));
    const float = Buffer.from(plain);
    float.writeUInt16LE(3, 20);
    expect(() => readWav(float)).toThrow(/16-bit PCM/);
  });
});

describe('the box and the database', () => {
  it('reads docker stats, the host size and the db:call-stats JSON pnpm printed', () => {
    expect(bytes('80.5MiB')).toBe(80.5 * 2 ** 20);
    expect(bytes('1.2GB')).toBe(1.2e9);
    const samples = parseDockerStats('{"Name":"attendra-api-1","CPUPerc":"57.10%","MemUsage":"300MiB / 768MiB","MemPerc":"39.06%"}\n');
    expect(samples).toEqual([{ name: 'attendra-api-1', cpuPct: 57.1, memBytes: 300 * 2 ** 20, memLimitBytes: 768 * 2 ** 20, memPct: 39.06 }]);
    expect(parseHost('4\n               total        used\nMem:     8000000000  1000\nSwap: 0 0\n')).toEqual({ cores: 4, memBytes: 8e9 });
    const json = JSON.stringify({ since: 'x', groups: [], calls: [{ id: 'abcd1234', closeReason: 'caller_hangup', firstAudioMs: 900, stalls: 1, answerTimeouts: 0, voiceOnlyMs: [800], lookupMs: [2100], segments: 9 }] }, null, 2);
    expect(parseCallStats(`> @attendra/db call-stats\n${json}\n`)).toEqual([{ id: 'abcd1234', closeReason: 'caller_hangup', firstAudioMs: 900, stalls: 1, answerTimeouts: 0, voiceOnlyMs: [800], lookupMs: [2100] }]);
    expect(() => parseCallStats(JSON.stringify({ groups: [] }))).toThrow(/--calls --json/);
    expect(callStatsCommand('attendra-api-1', ['clinic_a'], 'S', 'U')).toEqual(['docker', 'exec', 'attendra-api-1', 'pnpm', '--silent', 'db:call-stats', 'clinic_a', '--since', 'S', '--until', 'U', '--calls', '--json']);
  });
});

describe('change streams', () => {
  let server: Server | null = null;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  it('splits whole events from what is still coming', () => {
    expect(splitEvents('retry: 3000\n\nid: 7\nevent: ready\ndata: {}\n\nid: 8\nevent: cha')).toEqual({
      events: [{ event: null, id: null, retry: 3000 }, { event: 'ready', id: '7', retry: null }], rest: 'id: 8\nevent: cha',
    });
  });

  it('counts a stream the server ends as a drop, and comes back with the last id', async () => {
    const lastIds: (string | undefined)[] = [];
    server = createServer((req, res) => {
      lastIds.push(req.headers['last-event-id'] as string | undefined);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`retry: 50\n\nid: c${lastIds.length}\nevent: ready\ndata: {}\n\nid: d${lastIds.length}\nevent: change\ndata: {}\n\n`);
      if (lastIds.length === 1) setTimeout(() => res.end(), 30); // the first connection is dropped
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const stop = new AbortController();
    const s = holdStream({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, cookie: 'a=1', index: 0, clinicId: 'clinic_a', signal: stop.signal });
    await expect.poll(() => s.record.opens, { timeout: 5000 }).toBe(2);
    await expect.poll(() => s.record.changes).toBe(2);
    stop.abort();
    await s.done;
    expect(lastIds).toEqual([undefined, 'd1']);
    expect(s.record).toMatchObject({ opens: 2, failedReconnects: 0, changes: 2 });
    expect(s.record.drops).toEqual([{ at: expect.any(String), reason: 'stream ended' }]);
    expect(s.record.readyMs).toEqual(expect.any(Number));
  });
});

describe('the verdict', () => {
  const call = (id: string, over: Partial<CallAttempt> = {}): CallAttempt => ({ slot: 0, clinicId: 'clinic_a', callId: id, dialledAt: 't', liveAt: 't', endedAt: 't', endedBy: 'script', failure: null, ...over });
  const measured = (id: string, over: Partial<MeasuredCall> = {}): MeasuredCall => ({ id, closeReason: 'caller_hangup', firstAudioMs: 800, stalls: 0, answerTimeouts: 0, voiceOnlyMs: [1000, 1200], lookupMs: [2500], ...over });
  const run = (over: Partial<Run> = {}): Run => ({
    version: 1, base: 'https://staging.example.com', clinics: ['clinic_a'], mode: 'real', plan: { calls: 2, streams: 1, minutes: 15, callSeconds: 180 },
    startedAt: '2026-11-07T10:00:00.000Z', endedAt: '2026-11-07T10:15:00.000Z',
    calls: [call('11111111-aaaa'), call('22222222-bbbb')],
    streams: [{ index: 0, clinicId: 'clinic_a', opens: 1, readyMs: 40, drops: [], failedReconnects: 0, changes: 12, longestSilenceMs: 15_000 }],
    rateLimited: 0, measuredFrom: 'database', measured: [measured('11111111'), measured('22222222'), measured('99999999', { voiceOnlyMs: [60_000] })],
    host: { cores: 4, memBytes: 8e9 },
    samples: [{ at: 't', containers: [{ name: 'attendra-api-1', cpuPct: 120, memBytes: 3e8, memLimitBytes: 8e8, memPct: 37.5 }, { name: 'attendra-voice-1', cpuPct: 80, memBytes: 2e8, memLimitBytes: 8e8, memPct: 25 }] }],
    notes: [],
    ...over,
  });

  it('holds the voice service\'s own limits, not copies of them', () => {
    expect(THRESHOLDS.turnP90Ms).toBe(SILENCE_NUDGE_MS[0]);
    expect(THRESHOLDS.firstAudioP90Ms).toBe(OPENING_NUDGE_MS);
  });

  it('passes a clean run, counting only the run\'s own calls (matched by id prefix, as db:call-stats prints them)', () => {
    const s = summarise(run());
    expect(s.verdict).toBe('PASS');
    expect(s.turns).toMatchObject({ n: 6, max: 2500 });
    expect(s.resources.hostCpuPeak).toBe(0.5);
    expect(s.checks.every((c) => c.status === 'pass')).toBe(true);
    expect(markdown(run(), s)).toContain('# Load test: PASS');
  });

  it('fails on slow turns, a dropped call, a dropped stream, a 429 or a container near its memory limit, each on its own', () => {
    const failing = (r: Run) => summarise(r).checks.filter((c) => c.status === 'fail').map((c) => c.name);
    const slow = THRESHOLDS.turnP90Ms + 1;
    expect(failing(run({ measured: [measured('11111111', { voiceOnlyMs: [slow, slow, slow] }), measured('22222222', { voiceOnlyMs: [slow], lookupMs: [] })] }))).toEqual(['Turn time p90']);
    expect(failing(run({ measured: [measured('11111111', { closeReason: 'connection_lost' }), measured('22222222')] }))).toEqual(['Dropped calls']);
    expect(failing(run({ calls: [call('11111111-aaaa'), call('x', { callId: null, liveAt: null, endedBy: 'failed', failure: 'start answered 429 test_call_limit' })] }))).toEqual(['Dropped calls']);
    expect(failing(run({ streams: [{ ...run().streams[0]!, opens: 2, drops: [{ at: 't', reason: 'stream ended' }] }] }))).toEqual(['Dropped streams']);
    expect(failing(run({ rateLimited: 3 }))).toEqual(['Rate-limited answers (429)']);
    expect(failing(run({ samples: [{ at: 't', containers: [{ name: 'attendra-api-1', cpuPct: 10, memBytes: 7e8, memLimitBytes: 8e8, memPct: 87.5 }] }] }))).toEqual(['Container memory at peak']);
  });

  it('is incomplete, not passed, when the box was not sampled or first audio came from the API', () => {
    const s = summarise(run({ samples: [], host: null, measuredFrom: 'api', measured: [measured('11111111', { firstAudioMs: null, stalls: null }), measured('22222222', { firstAudioMs: null, stalls: null })] }));
    expect(s.verdict).toBe('INCOMPLETE');
    expect(s.checks.filter((c) => c.status === 'not measured').map((c) => c.name)).toEqual(['First audio p90', 'Host CPU at peak', 'Container memory at peak']);
    expect(s.stalls).toBeNull();
    expect(markdown(run(), s)).toContain('Not sampled');
  });
});
