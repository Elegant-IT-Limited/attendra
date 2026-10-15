// SPDX-License-Identifier: AGPL-3.0-only

/** What a test call asks the browser for. Browsers may quietly ignore any of it. */
export const MIC_CONSTRAINTS: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

export type MicProcessing = 'echoCancellation' | 'noiseSuppression';

/**
 * What the browser did with the processing we asked for, from the track's applied
 * settings: what it reports as off, and what it does not report at all. A setting it
 * does not report is unverified, not on: we cannot tell, so we say so.
 */
export function micCheck(settings: MediaTrackSettings): { off: MicProcessing[]; unverified: MicProcessing[] } {
  const asked = ['echoCancellation', 'noiseSuppression'] as const;
  return { off: asked.filter((k) => settings[k] === false), unverified: asked.filter((k) => settings[k] === undefined) };
}

/**
 * The note for the test call page, or null when the browser reports both on. Echo
 * comes first: without it the assistant hears itself. Even when it is on, it reduces
 * echo rather than removing it, which is why headphones stay the advice.
 */
export function micWarning(check: { off: MicProcessing[]; unverified: MicProcessing[] }): string | null {
  if (check.off.includes('echoCancellation')) return 'Your browser did not turn on echo cancellation for this microphone. Use headphones, or the assistant will hear itself and answer its own voice.';
  if (check.unverified.includes('echoCancellation')) return 'Your browser did not say whether echo cancellation is on for this microphone. Use headphones to be safe, or the assistant may hear itself.';
  if (check.off.includes('noiseSuppression')) return 'Your browser did not turn on noise suppression for this microphone. Background voices may be taken for the caller, so use a quiet room.';
  if (check.unverified.includes('noiseSuppression')) return 'Your browser did not say whether noise suppression is on for this microphone. Use a quiet room, so background voices are not taken for the caller.';
  return null;
}
