// SPDX-License-Identifier: AGPL-3.0-only
import { DEMO_CLINIC, talksAboutInternals } from '@attendra/core';
import { describe, expect, it } from 'vitest';
import { HOLD_AGAIN_LINE, HOLD_LINE } from '../src/realtime';
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
    expect(talksAboutInternals(HOLD_AGAIN_LINE)).toBe(false);
  });

  // note 52 B4: after the #153 fix a test call still heard "One moment. I'm still waiting on that lookup to finish."
  it('names the lookup phrases, and they count as talk about internals, EN and ES', () => {
    for (const prompt of [toolWork(DEMO_CLINIC).join('\n'), toolsVoiceStaticPrompt(DEMO_CLINIC)]) expect(prompt).toContain('"waiting on that lookup"');
    for (const line of ["One moment. I'm still waiting on that lookup to finish.", 'Still waiting on the search.', 'Waiting for the lookup to come back.', 'The lookup is slow today.', 'Estoy esperando la búsqueda.'])
      expect(talksAboutInternals(line), line).toBe(true);
    for (const line of ['Thanks for waiting.', 'Let me look that up.', 'Are you still waiting for the refill?', 'Gracias por esperar.']) expect(talksAboutInternals(line), line).toBe(false);
  });
});
