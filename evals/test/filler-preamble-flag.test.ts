import { describe, expect, it } from 'vitest';
import { Scenario } from '../src/scenario';
import { runScenario } from '../src/simulator';

// CQ2-R7: a scripted call whose reply opens with a banned filler preamble fails its eval; the same call without it passes.
const call = (reply: string) => Scenario.parse({
  id: 'cq2-r7-preamble-flag', title: 'CQ2-R7 flag', clinic: 'riverbend', local_time: '10:00', tags: ['no-demo'],
  turns: [{ caller: 'Is Dr. Ruiz in today?', reply, delegate: [{ get_clinic_info: { question: 'Is Dr. Ruiz in today?' } }] }],
  expect: { outcome: 'info' },
});

describe('CQ2-R7: the eval flags a reply that opens with a filler preamble', () => {
  it('CQ2-R7: "Let me check which vets are available..." fails the call; a plain answer passes', async () => {
    const flagged = await runScenario(call('Let me check which vets are available and then we can go from there.'));
    expect(flagged.failures.some((f) => f.startsWith('opened with a filler preamble')), JSON.stringify(flagged.failures)).toBe(true);
    const plain = await runScenario(call('Dr. Elena Ruiz works today.'));
    expect(plain.failures.filter((f) => f.startsWith('opened with a filler preamble'))).toEqual([]);
  });
});
