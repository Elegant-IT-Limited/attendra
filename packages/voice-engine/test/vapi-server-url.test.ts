import { describe, expect, it } from 'vitest';
import { vapiServerUrl } from '../src/vapi';

describe('the route Vapi posts to for one location', () => {
  it('drops trailing slashes from the base, however many, in linear time', () => {
    expect(vapiServerUrl('https://app.example.com', 'clinic_a')).toBe('https://app.example.com/webhooks/vapi/v1/events?clinic=clinic_a');
    expect(vapiServerUrl('https://app.example.com///', 'clinic_a')).toBe('https://app.example.com/webhooks/vapi/v1/events?clinic=clinic_a');
    const t = performance.now();
    expect(vapiServerUrl(`https://app.example.com${'/'.repeat(100_000)}x`, 'clinic_a')).toContain('/x/webhooks/');
    expect(performance.now() - t).toBeLessThan(200);
  });
});

// V3 (2026-11-18): the assistant's prompt and greeting reach Vapi in the words its voice says right (core forVapiVoice)
describe('the assistant\'s words for Vapi\'s voice', () => {
  it('has the title in full in the greeting and the prompt', async () => {
    const { ClinicConfig, DEMO_CLINIC } = await import('@attendra/core');
    const { vapiAssistant } = await import('../src/vapi');
    const clinic = ClinicConfig.parse({ ...DEMO_CLINIC, greeting: "Thanks for calling Dr. Maya Chen's office. I'm the clinic's AI assistant. How can I help?" });
    const a = vapiAssistant(clinic, { serverUrl: 'https://app.example.com/webhooks/vapi/v1/events?clinic=x', secret: 'x'.repeat(40) });
    expect(a.firstMessage).toBe("Thanks for calling Doctor Maya Chen's office. I'm the clinic's AI assistant. How can I help?");
    expect(a.model.messages[0]!.content).not.toMatch(/\bDra?\. \p{Lu}/u);
  });
});
