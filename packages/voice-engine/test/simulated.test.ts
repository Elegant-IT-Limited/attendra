import { describe, expect, it } from 'vitest';
import { type SidebandCommand, type SidebandEvent, SimulatedEngine } from '../src';

type Line = { speaker: 'caller' | 'agent'; text: string; start: number; end: number };

/** Plays a script and answers its one delegation the way the backend does, with commentary and an instruction at once. */
async function transcriptOf(reply: (send: (c: SidebandCommand) => void, delegationId: string) => void) {
  const engine = new SimulatedEngine();
  const id = engine.create({ turns: [{ assistant: 'Thank you for calling Willow Bend, this is Juniper.' }, { caller: 'Hi, when could I come in for a sick visit?', delegate: true }], pace: 10 });
  const sideband = engine.attach(id);
  const lines: Line[] = [];
  let done!: () => void;
  const finished = new Promise<void>((resolve) => { done = resolve; });
  sideband.onEvent((event: SidebandEvent) => {
    // the event union ends in a catch-all, so the two kinds read here are named by hand
    const e = event as SidebandEvent & { delta: string; start_ms: number; end_ms: number; delegation: { id: string } };
    if (e.type === 'session.input_transcript.delta' || e.type === 'session.output_transcript.delta') {
      lines.push({ speaker: e.type === 'session.input_transcript.delta' ? 'caller' : 'agent', text: e.delta, start: e.start_ms, end: e.end_ms });
      if (lines.length === 4) done();
    }
    if (e.type === 'session.delegation.created') reply((c) => sideband.send(c), e.delegation.id);
  });
  engine.play(id);
  await finished;
  await engine.hangup(id);
  return lines;
}

describe('the simulated engine\'s transcript', () => {
  it('says each line whole, one after another, even when the backend\'s instruction lands mid-conversation', async () => {
    const offer = 'For a sick visit I can offer Tuesday, October 27 at 10:20 AM, or Wednesday at 9:00 AM.';
    const lines = await transcriptOf((send, delegationId) => {
      // the backend answers the delegation, and in the same breath tells the voice to say goodbye
      send({ type: 'session.commentary.append', event_id: 'evt_1', delegation_id: delegationId, content: offer });
      send({ type: 'session.instructions.append', event_id: 'evt_2', delegation_id: null, content: 'Stop the current task. Thank the caller and say goodbye warmly, in one short sentence. Then say nothing more.' });
    });
    // every line is one segment, not fragments that could interleave
    expect(lines.map((l) => [l.speaker, l.text])).toEqual([
      ['agent', 'Thank you for calling Willow Bend, this is Juniper.'],
      ['caller', 'Hi, when could I come in for a sick visit?'],
      ['agent', 'Thank you for calling. Take care, goodbye.'],
      ['agent', offer],
    ]);
    // and in time order, none starting before the one before it has ended
    for (let i = 1; i < lines.length; i++) expect(lines[i]!.start, `line ${i}`).toBeGreaterThanOrEqual(lines[i - 1]!.end);
    for (const l of lines) expect(l.end).toBeGreaterThan(l.start);
  });

  it('a "Say exactly" instruction is said as one line too', async () => {
    const lines = await transcriptOf((send, delegationId) => {
      send({ type: 'session.instructions.append', event_id: 'evt_3', delegation_id: null, content: 'Stop the current task. Say exactly: "One moment, I am passing you to the team." Then say nothing more.' });
      send({ type: 'session.commentary.append', event_id: 'evt_4', delegation_id: delegationId, content: 'Tuesday at 9:00 AM works.' });
    });
    expect(lines.slice(2).map((l) => l.text)).toEqual(['One moment, I am passing you to the team.', 'Tuesday at 9:00 AM works.']);
    expect(lines[3]!.start).toBeGreaterThanOrEqual(lines[2]!.end);
  });
});
