import { DEMO_CLINIC } from '@attendra/core';
import { describe, expect, it } from 'vitest';
import { vapiAssistant } from '../src/vapi';

// Call quality Q4 and Q5 on Vapi (2026-11-18): callers answered before they finished, and background words acted on.
describe('the Vapi assistant', () => {
  it('waits 0.6 s before it speaks and takes background voices out first', () => {
    const a = vapiAssistant(DEMO_CLINIC, { serverUrl: 'https://voice.example.test/webhooks/vapi/v1/events', secret: 's' });
    expect(a.startSpeakingPlan.waitSeconds).toBe(0.6);
    expect(a.backgroundSpeechDenoisingPlan).toEqual({ smartDenoisingPlan: { enabled: true } });
  });
});
