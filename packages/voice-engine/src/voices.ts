// SPDX-License-Identifier: AGPL-3.0-only
import type { BuiltInVoiceName } from '@attendra/core';
import type { BuiltInVoice } from 'openai/resources/live/live';

// Settings offers core's list of voices; these two lines fail to compile when it and
// the SDK's BuiltInVoice drift apart, in either direction.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const VOICES_MATCH_THE_SDK: Same<BuiltInVoiceName, BuiltInVoice> = true;
