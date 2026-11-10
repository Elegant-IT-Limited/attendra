import { afterEach, describe, expect, it, vi } from 'vitest';
import { alertStep, createAlerter, ntfyPager, P0_KINDS, PAGE_COOLDOWN_MS, type Page, type Pager, pagerFromEnv, runbookLink } from '../src';

const RUNBOOKS = 'https://runbooks.example/attendra';
const DO = (kind: string) => ` Do: ${alertStep(kind)}`;
const slack = () => {
  const sent: string[] = [];
  return { sent, post: async (_u: string, body: unknown) => { sent.push((body as { text: string }).text); } };
};
const recorder = () => {
  const pages: Page[] = [];
  const pager: Pager = { channel: 'test', page: async (p) => { pages.push(p); } };
  return { pages, pager };
};

describe('paging the P0 alert kinds', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('pages a kind that is P0 on its first alert, with the runbook, and never pages one that is not', async () => {
    const { sent, post } = slack();
    const { pages, pager } = recorder();
    const a = createAlerter({ webhookUrl: 'https://hooks.slack.com/services/T/B/x', service: 'api', pager, runbookUrl: RUNBOOKS, post });
    a.alert('change_notices_down', 'no change notices for 10 s.');
    a.alert('call_rejected', 'A call matched no clinic. Dialled: +13035550142.');
    a.alert('job_failed', 'a job gave up.');
    await new Promise((r) => setTimeout(r, 0));
    expect(pages).toEqual([{ service: 'api', kind: 'change_notices_down', text: `no change notices for 10 s.${DO('change_notices_down')}`, link: `${RUNBOOKS}/change-notices-down.md` }]);
    // the P0 line in Slack says so, with the same runbook; the others are as before
    expect(sent[0]).toBe(`[api] :rotating_light: change_notices_down: no change notices for 10 s.${DO('change_notices_down')} [P0, runbook: ${RUNBOOKS}/change-notices-down.md]`);
    expect(sent[1]).toBe(`[api] :rotating_light: call_rejected: A call matched no clinic. Dialled: …0142.${DO('call_rejected')}`);
  });

  it('pages a burst kind only once it reaches its count within the window, cut to the last 4 digits, and once an hour at most', async () => {
    vi.useFakeTimers();
    const { post } = slack();
    const { pages, pager } = recorder();
    const after = P0_KINDS.empty_call!.after;
    const a = createAlerter({ webhookUrl: 'https://hooks.slack.com/services/T/B/x', service: 'voice', pager, runbookUrl: RUNBOOKS, windowMs: 60_000, post });
    for (let i = 1; i < after; i++) a.alert('empty_call', `caller ${i} heard nothing. From +13035550142.`);
    await vi.advanceTimersByTimeAsync(0);
    expect(pages).toEqual([]);
    a.alert('empty_call', 'caller heard nothing. From +13035550142.');
    await vi.advanceTimersByTimeAsync(0);
    expect(pages).toEqual([{ service: 'voice', kind: 'empty_call', text: `${after} within 1 min. Latest: caller heard nothing. From …0142.${DO('empty_call')}`, link: `${RUNBOOKS}/calls-failing.md` }]);
    // still failing in the next window: Slack hears every window, the phone not again within the hour
    await vi.advanceTimersByTimeAsync(60_000);
    for (let i = 0; i < after; i++) a.alert('empty_call', 'again');
    await vi.advanceTimersByTimeAsync(0);
    expect(pages).toHaveLength(1);
    // an hour on, a burst that is still going pages again
    await vi.advanceTimersByTimeAsync(PAGE_COOLDOWN_MS);
    for (let i = 0; i < after; i++) a.alert('empty_call', 'still');
    await vi.advanceTimersByTimeAsync(0);
    expect(pages).toHaveLength(2);
    // a few spread across windows never add up to a page
    const b = recorder();
    const spread = createAlerter({ webhookUrl: 'https://hooks.slack.com/services/T/B/x', service: 'voice', pager: b.pager, windowMs: 60_000, post });
    for (let i = 0; i < after * 3; i++) { spread.alert('call_dropped', 'one'); await vi.advanceTimersByTimeAsync(61_000); }
    expect(b.pages).toEqual([]);
  });

  it('is off without a pager, and a pager that fails is a warning, never an error', async () => {
    const warn = vi.fn();
    const quiet = createAlerter({ service: 'api', log: { warn }, pager: null });
    quiet.alert('change_notices_down', 'x');
    expect(warn).toHaveBeenCalledWith({ alert: `[api] :rotating_light: change_notices_down: x${DO('change_notices_down')} [P0]` }, 'alert (no Slack webhook set)');
    const failing: Pager = { channel: 'test', page: async () => { throw new Error('pager answered 502'); } };
    createAlerter({ service: 'api', log: { warn }, pager: failing }).alert('change_notices_down', 'x');
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenLastCalledWith({ err: { message: 'pager answered 502' } }, 'page not sent');
  });

  it('takes the pager from the environment: ntfy when its topic is set, off when unset or not https', () => {
    const warn = vi.fn();
    expect(pagerFromEnv({})).toBeNull();
    expect(pagerFromEnv({ ATTENDRA_PAGER_NTFY_URL: '' })).toBeNull();
    expect(pagerFromEnv({ ATTENDRA_PAGER_NTFY_URL: 'http://ntfy.example/topic' }, { warn })).toBeNull();
    expect(warn).toHaveBeenCalledWith({}, 'paging is off: ATTENDRA_PAGER_NTFY_URL must be an https:// topic address');
    expect(pagerFromEnv({ ATTENDRA_PAGER_NTFY_URL: 'https://ntfy.example/attendra-oncall-7f3a' })?.channel).toBe('ntfy');
  });

  it('posts to ntfy at the top priority, with the runbook to tap and the token when there is one', async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const pager = ntfyPager({ url: 'https://ntfy.example/attendra-oncall-7f3a', token: 'tk_example', post: async (url, init) => { calls.push({ url, ...init }); } });
    await pager.page({ service: 'api', kind: 'change_notices_down', text: 'no change notices.', link: `${RUNBOOKS}/change-notices-down.md` });
    expect(calls).toEqual([{
      url: 'https://ntfy.example/attendra-oncall-7f3a',
      headers: { Title: 'Attendra P0: change_notices_down (api)', Priority: 'urgent', Tags: 'rotating_light', Click: `${RUNBOOKS}/change-notices-down.md`, Authorization: 'Bearer tk_example' },
      body: `no change notices.\nRunbook: ${RUNBOOKS}/change-notices-down.md`,
    }]);
  });

  it('links each P0 kind to its runbook, only over https, and nothing for other kinds', () => {
    expect(runbookLink(`${RUNBOOKS}/`, 'call_failed')).toBe(`${RUNBOOKS}/calls-failing.md`);
    expect(runbookLink(`${RUNBOOKS}///`, 'call_failed')).toBe(`${RUNBOOKS}/calls-failing.md`);
    // a long run of slashes is trimmed at once, not in time that grows with its square
    expect(runbookLink(`${RUNBOOKS}${'/'.repeat(50_000)}`, 'call_failed')).toBe(`${RUNBOOKS}/calls-failing.md`);
    expect(runbookLink(undefined, 'call_failed')).toBeUndefined();
    expect(runbookLink('http://runbooks.example', 'call_failed')).toBeUndefined();
    expect(runbookLink(RUNBOOKS, 'call_rejected')).toBeUndefined();
    expect(runbookLink(RUNBOOKS, 'constructor')).toBeUndefined();
  });
});
