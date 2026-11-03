import { describe, expect, it, vi } from 'vitest';
import { mustWarnBeforeLeaving, type RecordingDeps, recordingName, type SaveDeps, type SavedRecording, saveRecording, startCallRecording } from '../lib/call-recording';

/** The browser's audio graph and recorder, as fakes that remember what was connected and recorded. */
function fakes(supported: string[]) {
  const connected: string[] = [];
  const recorders: FakeRecorder[] = [];
  const mixed = { id: 'mixed' } as unknown as MediaStream;
  class FakeContext {
    closed = false;
    createMediaStreamDestination() { return { stream: mixed }; }
    createMediaStreamSource(s: MediaStream) { return { connect: () => { connected.push((s as unknown as { id: string }).id); } }; }
    resume() { return Promise.resolve(); }
    close() { this.closed = true; return Promise.resolve(); }
  }
  class FakeRecorder {
    static isTypeSupported(t: string) { return supported.includes(t); }
    state: RecordingState = 'inactive';
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    timeslice: number | undefined;
    constructor(readonly stream: MediaStream, readonly options?: MediaRecorderOptions) { recorders.push(this); }
    get mimeType() { return this.options?.mimeType ?? ''; }
    start(timeslice?: number) { this.state = 'recording'; this.timeslice = timeslice; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['last second']) }); this.onstop?.(); }
  }
  const deps = {
    AudioContext: FakeContext, MediaRecorder: FakeRecorder, createObjectURL: () => 'blob:local/1', now: () => new Date(2026, 10, 8, 14, 32),
  } as unknown as RecordingDeps;
  return { deps, connected, recorders, mixed };
}
const stream = (id: string, tracks = 1) => ({ id, getAudioTracks: () => Array.from({ length: tracks }) }) as unknown as MediaStream;

describe('recording a browser test call on this computer', () => {
  it('mixes the assistant and the microphone into one recording, a chunk a second', () => {
    const f = fakes(['audio/webm;codecs=opus']);
    startCallRecording(stream('assistant'), stream('mic'), f.deps);
    expect(f.connected).toEqual(['assistant', 'mic']);
    expect(f.recorders).toHaveLength(1);
    expect(f.recorders[0]!.stream).toBe(f.mixed);
    expect(f.recorders[0]!.options).toEqual({ mimeType: 'audio/webm;codecs=opus' });
    expect(f.recorders[0]!.timeslice).toBe(1000);
  });

  it('hands back a file to save, named for when the call started, and sends nothing anywhere', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const f = fakes(['audio/mp4']);
    const r = startCallRecording(stream('assistant'), null, f.deps);
    f.recorders[0]!.ondataavailable?.({ data: new Blob(['first second']) } as BlobEvent);
    const saved = await r.stop();
    expect(saved.name).toBe('attendra-test-call-2026-11-08-1432.m4a');
    expect(saved.url).toBe('blob:local/1');
    expect(await saved.blob.text()).toBe('first secondlast second');
    expect(saved.blob.type).toBe('audio/mp4');
    // stopping twice gives the same file
    expect(await r.stop()).toBe(saved);
    expect(f.connected).toEqual(['assistant']);
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });

  it('keeps the chunks in the order they arrive, drops empty ones, and falls back to WebM when the browser names no type', async () => {
    const f = fakes([]);
    const r = startCallRecording(stream('assistant'), stream('mic', 0), f.deps);
    // a microphone with no audio track is left out of the mix
    expect(f.connected).toEqual(['assistant']);
    expect(f.recorders[0]!.options).toBeUndefined();
    for (const data of ['one ', '', 'two ', 'three ']) f.recorders[0]!.ondataavailable?.({ data: new Blob([data]) } as BlobEvent);
    const saved = await r.stop();
    expect(await saved.blob.text()).toBe('one two three last second');
    expect(saved.blob.type).toBe('audio/webm');
    expect(saved.name).toBe('attendra-test-call-2026-11-08-1432.webm');
    expect(f.recorders[0]!.state).toBe('inactive');
  });

  it('names the file by its type', () => {
    expect(recordingName(new Date(2026, 0, 5, 9, 7), 'webm')).toBe('attendra-test-call-2026-01-05-0907.webm');
  });
});

/** A page that remembers every download link clicked, or refuses the click. */
function page(refuse = false) {
  const clicks: { href: string; download: string }[] = [];
  const deps: SaveDeps = {
    createElement: () => {
      const a = { href: '', download: '', click() { if (refuse) throw new Error('blocked'); clicks.push({ href: a.href, download: a.download }); }, remove() {} };
      return a;
    },
    append: () => {},
  };
  return { deps, clicks };
}

describe('saving the recording by itself', () => {
  it('saves once, under its name, and "Save again" saves the same file; nothing goes over the network', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const f = fakes(['audio/webm;codecs=opus']);
    const r = startCallRecording(stream('assistant'), stream('mic'), f.deps);
    const saved = await r.stop();
    const p = page();
    expect(saveRecording(saved, p.deps)).toBe(true);
    expect(p.clicks).toEqual([{ href: 'blob:local/1', download: 'attendra-test-call-2026-11-08-1432.webm' }]);
    expect(saveRecording(saved, p.deps)).toBe(true);
    expect(p.clicks).toHaveLength(2);
    expect(p.clicks[1]).toEqual(p.clicks[0]);
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });

  it('says so when the browser refuses, so the page can offer the link', () => {
    const p = page(true);
    expect(saveRecording({ url: 'blob:local/2', name: 'attendra-test-call-2026-11-08-1432.webm', blob: new Blob([]) }, p.deps)).toBe(false);
    expect(p.clicks).toEqual([]);
  });

  it('asks before leaving while it records, while it stops, and until it is saved', () => {
    const rec: SavedRecording = { url: 'blob:local/3', name: 'attendra-test-call-2026-11-08-1432.webm', blob: new Blob([]) };
    const at = (recording: boolean, stopping: boolean, saved: SavedRecording | null, savedAt: Date | null) => mustWarnBeforeLeaving({ recording, stopping, saved, savedAt });
    expect(at(false, false, null, null)).toBe(false); // before any call
    expect(at(true, false, null, null)).toBe(true); // recording
    expect(at(false, true, null, null)).toBe(true); // the call ended, the file is being made
    expect(at(false, false, rec, null)).toBe(true); // the browser refused to save it
    expect(at(false, false, rec, new Date())).toBe(false); // saved
  });
});
