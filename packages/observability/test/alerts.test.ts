import { describe, expect, it, vi } from 'vitest';
import { createAlerter, maskNumbers } from '../src';

describe('alerts for the people who run Attendra', () => {
  it('sends the first alert of a kind at once, counts repeats into one line, then says when it is back to normal', async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const a = createAlerter({ webhookUrl: 'https://hooks.slack.com/services/T/B/x', service: 'voice', windowMs: 60_000, post: async (_u, body) => { sent.push((body as { text: string }).text); } });
    a.alert('call_rejected', 'A call matched no clinic. Dialled: +15163630790.');
    a.alert('call_rejected', 'again');
    a.alert('call_rejected', 'and again');
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(['[voice] :rotating_light: call_rejected: A call matched no clinic. Dialled: …0790.']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent[1]).toBe('[voice] :warning: call_rejected: 2 more in the last 1 min. Latest: and again');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent[2]).toBe('[voice] :white_check_mark: call_rejected: back to normal (none for 1 min).');
    a.alert('call_rejected', 'a new one');
    await vi.advanceTimersByTimeAsync(0);
    expect(sent[3]).toContain(':rotating_light: call_rejected: a new one');
    vi.useRealTimers();
  });

  it('only logs without a webhook, never throws when Slack is down, and cuts every phone number to its last 4 digits', async () => {
    const warn = vi.fn();
    createAlerter({ service: 'worker', log: { warn } }).alert('job_failed', 'x');
    expect(warn).toHaveBeenCalledWith({ alert: '[worker] :rotating_light: job_failed: x' }, 'alert (no Slack webhook set)');
    const down = createAlerter({ webhookUrl: 'https://hooks.slack.com/services/T/B/x', service: 'worker', log: { warn }, post: async () => { throw new Error('slack answered 500'); } });
    down.note('started');
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenLastCalledWith({ err: { message: 'slack answered 500' } }, 'alert not sent');
    expect(maskNumbers('from +1 (571) 656-1769 to 5163630790, clinic_6a2b')).toBe('from …1769 to …0790, clinic_6a2b');
  });
});
