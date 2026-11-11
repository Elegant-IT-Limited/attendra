// SPDX-License-Identifier: AGPL-3.0-only
import { DEMO_CLINIC, talksAboutInternals } from '@attendra/core';
import { describe, expect, it } from 'vitest';
import { HOLD_LINE } from '../src/realtime';
import { toolsVapiPrompt, toolsVoiceStaticPrompt, toolWork } from '../src/tools-prompt';

// Note 49 B2: a test call heard "It's still running in the background" and "the information returned is only an
// address". The voice is told never to say it, on every path, and the words for a slow lookup are a front desk's.
describe('the voice never talks about how it works', () => {
  it('every tools-path prompt says so, and the words while waiting are "One moment."', () => {
    for (const prompt of [toolWork(DEMO_CLINIC).join('\n'), toolsVoiceStaticPrompt(DEMO_CLINIC), toolsVapiPrompt(DEMO_CLINIC)]) {
      expect(prompt).toContain('Never describe how you work');
      expect(prompt).toContain('say only "One moment."');
    }
    expect(HOLD_LINE).toContain('"One moment."');
    expect(talksAboutInternals(HOLD_LINE)).toBe(false);
  });
});
