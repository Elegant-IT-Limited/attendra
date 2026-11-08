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
export const PREVIEW_VOICES = ['alloy', 'ash', 'ballad', 'cedar', 'coral', 'echo', 'marin', 'sage', 'shimmer', 'verse'] as const satisfies readonly BuiltInVoiceName[];
export const hasPreview = (voice: string) => (PREVIEW_VOICES as readonly string[]).includes(voice);

/**
 * The voices the gpt-realtime models speak (path A): the same as the speech model's. A clinic voice outside it is heard
 * as the default on gpt-realtime (voice-engine voiceFor), so a switch made to try voices by ear offers only these.
 */
export const REALTIME_VOICES = PREVIEW_VOICES;

/**
 * Voices to try by ear on a test call (note 18, 2026-11-08), against the default, marin: picked from REALTIME_VOICES for
 * a warm front desk. Nothing here has been listened to yet: the pick is made by ear, on test calls.
 */
export const VOICE_CANDIDATES: readonly { voice: (typeof REALTIME_VOICES)[number]; why: string }[] = [
  { voice: 'cedar', why: 'Released with gpt-realtime alongside marin as its most natural-sounding pair: a warm, lower voice, the closest to marin in quality.' },
  { voice: 'coral', why: 'Bright and friendly: the cheerful front-desk sound, for clinics that want more smile in the greeting.' },
  { voice: 'sage', why: 'Calm and gentle: steadier for worried or upset owners, and on emergency lines.' },
];

/** "Marin (the default)", "Cedar". A saved voice that is not built in keeps its own name. */
export const voiceLabel = (voice: string) => `${voice.charAt(0).toUpperCase()}${voice.slice(1)}${voice === DEFAULT_VOICE ? ' (the default)' : ''}`;
