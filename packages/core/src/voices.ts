// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The GPT-Live built-in voices, the same list as the OpenAI SDK's `BuiltInVoice`
 * type (packages/voice-engine checks that the two match at compile time). The SDK
 * gives names only, so Settings shows the names, with the SDK's default marked.
 */
export const BUILT_IN_VOICES = [
  'alloy', 'ash', 'ballad', 'beacon', 'bossa', 'cedar', 'cinder', 'coral', 'delta', 'echo', 'gleam',
  'marin', 'meridian', 'quartz', 'ripple', 'sage', 'shida', 'shimmer', 'stone', 'tempo', 'verse', 'vesper', 'willow',
] as const;
export type BuiltInVoiceName = (typeof BUILT_IN_VOICES)[number];
export const DEFAULT_VOICE: BuiltInVoiceName = 'marin';

/**
 * The voices Settings can play a preview of, from OpenAI's speech model. The others
 * exist only in the Live model, which speaks only on a call, so they are heard in a
 * test call.
 */
export const PREVIEW_VOICES: readonly BuiltInVoiceName[] = ['alloy', 'ash', 'ballad', 'cedar', 'coral', 'echo', 'marin', 'sage', 'shimmer', 'verse'];
export const hasPreview = (voice: string) => (PREVIEW_VOICES as readonly string[]).includes(voice);

/** "Marin (the default)", "Cedar". A saved voice that is not built in keeps its own name. */
export const voiceLabel = (voice: string) => `${voice.charAt(0).toUpperCase()}${voice.slice(1)}${voice === DEFAULT_VOICE ? ' (the default)' : ''}`;
