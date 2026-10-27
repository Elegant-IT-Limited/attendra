// SPDX-License-Identifier: AGPL-3.0-only

/** A finished recording: kept in this browser only, until the person saves it or the page is closed. */
export interface SavedRecording { url: string; name: string; blob: Blob }

/** What the recorder needs from the browser; tests pass fakes. */
export interface RecordingDeps {
  AudioContext: new () => Pick<AudioContext, 'createMediaStreamSource' | 'createMediaStreamDestination' | 'resume' | 'close'>;
  MediaRecorder: { new (stream: MediaStream, options?: MediaRecorderOptions): Pick<MediaRecorder, 'start' | 'stop' | 'state' | 'ondataavailable' | 'onstop' | 'mimeType'>; isTypeSupported(type: string): boolean };
  createObjectURL: (blob: Blob) => string;
  now: () => Date;
}

/** Opus in WebM where the browser has it (Chrome, Firefox, Edge), else MP4 audio (Safari). */
const TYPES = [['audio/webm;codecs=opus', 'webm'], ['audio/webm', 'webm'], ['audio/mp4', 'm4a']] as const;

/** Whether this browser can record a test call at all. */
export function canRecord(): boolean {
  return typeof window !== 'undefined' && typeof window.MediaRecorder !== 'undefined' && typeof window.AudioContext !== 'undefined';
}

/** "attendra-test-call-2026-11-08-1432.webm": the date and local time it started. */
export function recordingName(startedAt: Date, extension: string): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `attendra-test-call-${startedAt.getFullYear()}-${p(startedAt.getMonth() + 1)}-${p(startedAt.getDate())}-${p(startedAt.getHours())}${p(startedAt.getMinutes())}.${extension}`;
}

/**
 * Records a browser test call on this computer: the assistant's audio (the call's remote stream) and the microphone,
 * mixed into one track with WebAudio, by the browser's MediaRecorder. Nothing is uploaded or sent anywhere: the
 * recording stays in this tab's memory until `stop()` hands it back as a file to save. For hearing what a call sounded
 * like (a voice that seemed to change, 2026-10-26), which the transcript cannot show.
 */
export function startCallRecording(remote: MediaStream, mic: MediaStream | null, deps: RecordingDeps = browserDeps()) {
  const ctx = new deps.AudioContext();
  void ctx.resume().catch(() => {});
  const mixed = ctx.createMediaStreamDestination();
  ctx.createMediaStreamSource(remote).connect(mixed);
  if (mic?.getAudioTracks().length) ctx.createMediaStreamSource(mic).connect(mixed);
  const [mimeType, extension] = TYPES.find(([t]) => deps.MediaRecorder.isTypeSupported(t)) ?? [undefined, 'webm'];
  const recorder = new deps.MediaRecorder(mixed.stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  const startedAt = deps.now();
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  // a chunk a second, so a tab that crashes mid-call has lost at most a second of it
  recorder.start(1000);
  let stopped: Promise<SavedRecording> | null = null;
  return {
    /** Stops, and hands back the recording as a file this browser holds. Safe to call more than once. */
    stop(): Promise<SavedRecording> {
      stopped ??= new Promise((resolve) => {
        const done = () => {
          void ctx.close().catch(() => {});
          const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
          resolve({ blob, url: deps.createObjectURL(blob), name: recordingName(startedAt, extension) });
        };
        if (recorder.state === 'inactive') return done();
        recorder.onstop = done;
        recorder.stop();
      });
      return stopped;
    },
  };
}

function browserDeps(): RecordingDeps {
  return { AudioContext: window.AudioContext, MediaRecorder: window.MediaRecorder, createObjectURL: (b) => URL.createObjectURL(b), now: () => new Date() };
}
