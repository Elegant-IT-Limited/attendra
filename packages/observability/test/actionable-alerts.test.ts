import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALERT_STEP_KINDS, alertStep, createAlerter, isOpenAiQuotaError, isVapiCreditEnd, isVapiOpenAiQuotaEnd, P0_KINDS, PAGE_COOLDOWN_MS,
  pagerFromEnv, slackPager,
} from '../src';

const HOOK = 'https://hooks.slack.com/services/T/B/x';
const APP = 'https://app.example.test';
const slack = () => {
  const sent: string[] = [];
  return { sent, post: async (_u: string, body: unknown) => { sent.push((body as { text: string }).text); } };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('every call alert names the clinic, links the call and says what to do', () => {
  it('adds the clinic name (looked up once), the call link and the step; the caller\'s number is cut, our ids are not', async () => {
    const { sent, post } = slack();
    const lookup = vi.fn(async (id: string) => (id === 'clinic_12345678abcdef90' ? 'Maple Grove Vet' : undefined));
    const a = createAlerter({ webhookUrl: HOOK, service: 'voice', appUrl: `${APP}/`, clinicName: lookup, pager: null, post });
    a.alert('call_dropped', 'A call dropped before it ended (error). From +13035550142.', { clinicId: 'clinic_12345678abcdef90', callId: '12345678-1234-4abc-8def-1234567890ab' });
    await tick();
    expect(sent[0]).toBe('[voice] :rotating_light: call_dropped: A call dropped before it ended (error). From …0142.'
      + ' Clinic: Maple Grove Vet (clinic_12345678abcdef90).'
      + ` Call: <${APP}/c/clinic_12345678abcdef90/calls/12345678-1234-4abc-8def-1234567890ab|open the call>.`
      + ` Do: ${alertStep('call_dropped')} [P0]`);
    // the name is remembered: a second alert about the same clinic does not read it again
    a.alert('empty_call', 'x', { clinicId: 'clinic_12345678abcdef90', callId: 'c2' });
    await tick();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(sent[1]).toContain('Clinic: Maple Grove Vet (clinic_12345678abcdef90).');
  });

  it('keeps the id when the name cannot be read, leaves the link out without an address, and still says what to do', async () => {
    const { sent, post } = slack();
    const a = createAlerter({ webhookUrl: HOOK, service: 'worker', clinicName: async () => { throw new Error('db down'); }, pager: null, post });
    a.alert('text_failed', 'A text was not delivered (Twilio error 30007).', { clinicId: 'clinic_a1' });
    a.alert('job_failed', 'A background job gave up.');
    await tick();
    // a line with nothing to look up goes out at once; the other once its lookup gave up
    expect(sent).toEqual([
      `[worker] :rotating_light: job_failed: A background job gave up. Do: ${alertStep('job_failed')}`,
      `[worker] :rotating_light: text_failed: A text was not delivered (Twilio error 30007). Clinic: clinic_a1. Do: ${alertStep('text_failed')}`,
    ]);
  });

  it('uses a name the service already has, and the repeat count keeps the clinic and the link', async () => {
    vi.useFakeTimers();
    const { sent, post } = slack();
    const a = createAlerter({ webhookUrl: HOOK, service: 'voice', appUrl: APP, windowMs: 60_000, pager: null, post });
    a.alert('slow_answer', 'A caller waited 9 s.', { clinicId: 'clinic_a1', clinicName: 'Oak Street Animal Clinic', callId: 'c1' });
    a.alert('slow_answer', 'A caller waited 12 s.', { clinicId: 'clinic_a1', clinicName: 'Oak Street Animal Clinic', callId: 'c2' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent[1]).toBe(`[voice] :warning: slow_answer: 1 more in the last 1 min. Latest: A caller waited 12 s. Clinic: Oak Street Animal Clinic (clinic_a1). Call: <${APP}/c/clinic_a1/calls/c2|open the call>. Do: ${alertStep('slow_answer')}`);
    vi.useRealTimers();
  });

  it('has a step for every alert kind raised anywhere in the code', () => {
    const root = join(__dirname, '../../..');
    const kinds = new Set<string>();
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'test' || name === 'dist' || name.startsWith('.')) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          for (const m of readFileSync(p, 'utf8').matchAll(/\.alert\(\s*'([a-z_]+)'/g)) kinds.add(m[1]!);
        }
      }
    };
    for (const top of ['apps', 'packages']) walk(join(root, top));
    expect(kinds.size).toBeGreaterThan(10);
    const missing = [...kinds].filter((k) => !alertStep(k));
    expect(missing).toEqual([]);
    // and every P0 kind has one
    expect(Object.keys(P0_KINDS).filter((k) => !ALERT_STEP_KINDS.includes(k))).toEqual([]);
  });
});

describe('Slack is the pager: <!channel> on a P0 that pages, and on nothing else', () => {
  beforeEach(() => { vi.stubEnv('ATTENDRA_PAGER_NTFY_URL', ''); });
  afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

  it('sends one line with the mention when a P0 pages on its first alert, not a second line', async () => {
    const { sent, post } = slack();
    const a = createAlerter({ webhookUrl: HOOK, service: 'voice', post });
    a.alert('paging_test', 'TEST, no action needed.');
    await tick();
    expect(sent).toEqual([`<!channel> [voice] :rotating_light: paging_test: TEST, no action needed. Do: ${alertStep('paging_test')} [P0]`]);
  });

  it('never mentions below the P0 count, on a kind that is not P0, on a count, a recovery or a note; pages once at the count, then once an hour', async () => {
    vi.useFakeTimers();
    const { sent, post } = slack();
    const a = createAlerter({ webhookUrl: HOOK, service: 'voice', windowMs: 60_000, post });
    const after = P0_KINDS.call_failed!.after;
    a.alert('job_failed', 'not a P0');
    a.note('Voice service started.');
    for (let i = 1; i < after; i++) a.alert('call_failed', `failure ${i}`);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.filter((l) => l.includes('<!channel>'))).toEqual([]);
    a.alert('call_failed', 'one more');
    await vi.advanceTimersByTimeAsync(0);
    const pages = () => sent.filter((l) => l.includes('<!channel>'));
    expect(pages()).toEqual([`<!channel> [voice] :rotating_light: P0 call_failed: ${after} within 1 min. Latest: one more Do: ${alertStep('call_failed')}`]);
    // the window's count and the recovery carry no mention
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent.some((l) => l.includes(':warning: call_failed') && !l.includes('<!channel>'))).toBe(true);
    expect(sent.some((l) => l.includes(':white_check_mark: call_failed: back to normal') && !l.includes('<!channel>'))).toBe(true);
    // a burst again within the hour: Slack hears it, nobody is pinged
    for (let i = 0; i < after; i++) a.alert('call_failed', 'again');
    await vi.advanceTimersByTimeAsync(0);
    expect(pages()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(PAGE_COOLDOWN_MS);
    for (let i = 0; i < after; i++) a.alert('call_failed', 'still');
    await vi.advanceTimersByTimeAsync(0);
    expect(pages()).toHaveLength(2);
  });

  it('prefers ntfy when its topic is set, and is off with no webhook or with paging turned off', async () => {
    vi.stubEnv('ATTENDRA_PAGER_NTFY_URL', 'https://ntfy.example/attendra-oncall-7f3a');
    expect(pagerFromEnv(process.env)?.channel).toBe('ntfy');
    vi.stubEnv('ATTENDRA_PAGER_NTFY_URL', '');
    const warn = vi.fn();
    createAlerter({ service: 'api', log: { warn } }).alert('paging_test', 'x');
    expect(warn.mock.calls[0]![0].alert.startsWith('[api]')).toBe(true);
    const { sent, post } = slack();
    createAlerter({ webhookUrl: HOOK, service: 'api', pager: null, post }).alert('paging_test', 'x');
    await tick();
    expect(sent[0]!.startsWith('[api]')).toBe(true);
  });

  it('formats a page on its own: mention, service, P0 kind, text and runbook', async () => {
    const { sent, post } = slack();
    await slackPager({ url: HOOK, post }).page({ service: 'worker', kind: 'twilio_balance_low', text: 'Twilio balance $8.20.', link: 'https://runbooks.example/twilio-balance-low.md' });
    expect(sent).toEqual(['<!channel> [worker] :rotating_light: P0 twilio_balance_low: Twilio balance $8.20. Runbook: https://runbooks.example/twilio-balance-low.md']);
  });

  it('a balance P0 is not "back to normal" because it went quiet: its check says so, and the next drop pages at once', async () => {
    vi.useFakeTimers();
    const { sent, post } = slack();
    const a = createAlerter({ webhookUrl: HOOK, service: 'worker', windowMs: 60_000, post });
    a.alert('twilio_balance_low', 'Twilio balance $8.20, under $10.');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.startsWith('<!channel> ')).toBe(true);
    a.resolved('twilio_balance_low', 'Twilio balance $50.00.');
    await vi.advanceTimersByTimeAsync(0);
    expect(sent[1]).toBe('[worker] :white_check_mark: twilio_balance_low: back to normal. Twilio balance $50.00.');
    a.alert('twilio_balance_low', 'Twilio balance $4.00, under $10.');
    await vi.advanceTimersByTimeAsync(0);
    expect(sent[2]!.startsWith('<!channel> ')).toBe(true);
  });
});

describe('money that runs out is told apart from other errors', () => {
  it('reads OpenAI\'s quota and billing codes in SDK errors, event errors and messages, and not a rate limit', () => {
    expect(isOpenAiQuotaError({ status: 429, code: 'insufficient_quota', message: 'You exceeded your current quota' })).toBe(true);
    expect(isOpenAiQuotaError({ error: { type: 'insufficient_quota' } })).toBe(true);
    expect(isOpenAiQuotaError({ code: 'billing_hard_limit_reached' })).toBe(true);
    expect(isOpenAiQuotaError(new Error('accept failed: 429 {"error":{"code":"insufficient_quota"}}'))).toBe(true);
    expect(isOpenAiQuotaError({ status: 429, code: 'rate_limit_exceeded', message: 'Rate limit reached' })).toBe(false);
    expect(isOpenAiQuotaError(new Error('socket hang up'))).toBe(false);
    expect(isOpenAiQuotaError(null)).toBe(false);
  });

  it('reads Vapi\'s end reasons for a call it would not start for money', () => {
    expect(isVapiCreditEnd('call.start.error-subscription-insufficient-credits')).toBe(true);
    expect(isVapiCreditEnd('call.start.error-subscription-frozen')).toBe(true);
    expect(isVapiCreditEnd('call.start.error-subscription-concurrency-limit-reached')).toBe(false);
    expect(isVapiCreditEnd('customer-ended-call')).toBe(false);
    expect(isVapiCreditEnd(undefined)).toBe(false);
    expect(isVapiOpenAiQuotaEnd('pipeline-error-openai-429-exceeded-quota')).toBe(true);
    expect(isVapiOpenAiQuotaEnd('pipeline-error-openai-429-rate-limit-reached')).toBe(false);
  });
});
