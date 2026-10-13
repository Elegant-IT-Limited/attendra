// SPDX-License-Identifier: AGPL-3.0-only

/** What a test call asks the browser for. Browsers may quietly ignore any of it. */
export const MIC_CONSTRAINTS: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

export type MicProcessing = 'echoCancellation' | 'noiseSuppression';

/**
 * The processing we asked for that the browser did not turn on, read from the
 * track's applied settings. A browser that does not report a setting is not
 * counted as missing: we cannot tell, so we do not warn about it.
 */
export function missingProcessing(settings: MediaTrackSettings): MicProcessing[] {
  return (['echoCancellation', 'noiseSuppression'] as const).filter((k) => settings[k] === false);
}

/** The warning for the test call page, or null when nothing is missing. */
export function micWarning(missing: MicProcessing[]): string | null {
  if (missing.includes('echoCancellation')) return 'Your browser did not turn on echo cancellation for this microphone. Use headphones, or the assistant will hear itself and answer its own voice.';
  if (missing.includes('noiseSuppression')) return 'Your browser did not turn on noise suppression for this microphone. Background voices may be taken for the caller, so use a quiet room.';
  return null;
}
