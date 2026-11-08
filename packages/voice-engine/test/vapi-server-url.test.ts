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
