import { describe, expect, it } from 'vitest';
import {
  CALL_EVENTS_RETENTION_DAYS, type CallEvent, callPath, cleanEvent, dailyNumbers, formatCallEvents, formatDailyNumbers, maskQaLine, maskQaTranscript, type NumbersCall, percentileOf,
  providerEvent, STALL_MS, turnTimings,
} from '../src';

const SAID = 'Hi, this is Maria Delgado, my number is 303 555 0147';
const ev = (type: string, atMs: number, extra: Partial<CallEvent> = {}): CallEvent => ({ seq: 0, atMs, type, n: 1, lastMs: null, responseId: null, itemId: null, errorCode: null, errorType: null, ...extra });

describe('the per-call event log keeps types and ids, never content (foundation A, item 2)', () => {
  it('cuts a Realtime event down to its type, response id and item id', () => {
    expect(providerEvent({ type: 'response.output_audio_transcript.delta', event_id: 'ev_1', response_id: 'resp_1', item_id: 'item_1', delta: SAID })).toEqual({ type: 'response.output_audio_transcript.delta', responseId: 'resp_1', itemId: 'item_1' });
    expect(providerEvent({ type: 'response.done', response: { id: 'resp_2', output: [{ content: [{ transcript: SAID }] }] } })).toMatchObject({ type: 'response.done', responseId: 'resp_2' });
    expect(providerEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_3', transcript: SAID })).toMatchObject({ itemId: 'item_3' });
    expect(providerEvent({ type: 'response.function_call_arguments.done', call_id: 'call_9', name: 'verify_caller', arguments: JSON.stringify({ owner_name: 'Maria Delgado' }) })).toEqual({ type: 'response.function_call_arguments.done', responseId: null, itemId: 'call_9' });
    expect(JSON.stringify(providerEvent({ type: 'session.input_transcript.delta', delta: SAID, start_ms: 1, end_ms: 2 }))).not.toContain('Maria');
  });

  it('keeps an error\'s code and type, never its message, and only on an error', () => {
    const e = providerEvent({ type: 'error', error: { type: 'invalid_request_error', code: 'conversation_already_has_active_response', message: 'Conversation already has an active response in progress: resp_1. Maria said 303 555 0147' } });
    expect(e).toEqual({ type: 'error', responseId: null, itemId: null, errorCode: 'conversation_already_has_active_response', errorType: 'invalid_request_error' });
    expect(cleanEvent({ type: 'response.done', errorCode: 'x', errorType: 'y' })).toMatchObject({ errorCode: null, errorType: null });
  });

  it('drops anything that is not id-shaped: a sentence in an id field, or a type with spaces', () => {
    expect(cleanEvent({ type: 'gate.queued.reply', responseId: SAID, itemId: 'item 1' })).toEqual({ type: 'gate.queued.reply', responseId: null, itemId: null, errorCode: null, errorType: null });
    expect(cleanEvent({ type: SAID }).type).toBe('unknown');
    expect(providerEvent({ type: 'response.event', event: { type: 'response.output_text.delta', delta: SAID } }).type).toBe('response.event:response.output_text.delta');
  });

  it('names a call path from its engine and flow', () => {
    expect(callPath('gpt-realtime', 'tools')).toBe('gpt-realtime/tools');
    expect(callPath(null, null)).toBe('unknown/planner');
    expect(callPath('not an engine', 'tools')).toBe('unknown/tools');
    expect(CALL_EVENTS_RETENTION_DAYS).toBe(7);
  });

  it('times each caller turn from the end of their speech to the start of the reply, and counts 5 s silences as stalls', () => {
    const events = [
      ev('input_audio_buffer.speech_stopped', 1000), ev('response.created', 1100), ev('output_audio_buffer.started', 1800),
      ev('input_audio_buffer.speech_started', 4000), ev('input_audio_buffer.speech_stopped', 5000), ev('error', 5100), ev('output_audio_buffer.started', 11_500),
      // the caller waited, then spoke again: a stall with no reply time
      ev('input_audio_buffer.speech_stopped', 15_000), ev('input_audio_buffer.speech_started', 21_000),
      // a pause inside the caller's turn is no wait
      ev('input_audio_buffer.speech_stopped', 22_000), ev('input_audio_buffer.speech_started', 22_400), ev('input_audio_buffer.speech_stopped', 23_000), ev('response.output_audio_transcript.delta', 24_000),
    ];
    expect(STALL_MS).toBe(5000);
    expect(turnTimings(events)).toEqual({ turns: 5, replyMs: [800, 6500, 1000], stalls: 2, stallAtMs: [5000, 15_000] });
  });

  it('prints the timeline with gaps over 2 s marked', () => {
    const lines = formatCallEvents('call x', [ev('input_audio_buffer.speech_stopped', 1000), ev('response.created', 1200, { responseId: 'resp_1' }), ev('error', 4000, { errorCode: 'conversation_already_has_active_response', errorType: 'invalid_request_error' }), ev('response.output_audio_transcript.delta', 4100, { n: 12, lastMs: 5900, responseId: 'resp_2' })]);
    expect(lines[0]).toBe('call x');
    expect(lines.find((l) => l.includes(' error '))).toContain('<-- gap 2.8 s');
    expect(lines.find((l) => l.includes('resp_2'))).toContain('x12 to 5900');
    expect(lines.filter((l) => l.includes('<-- gap'))).toHaveLength(1);
    expect(lines.at(-1)).toBe('caller turns: 1; replies timed: 1; stalls over 5 s: 0');
  });
});

describe('the daily numbers (foundation A, item 7)', () => {
  const call = (o: Partial<NumbersCall>): NumbersCall => ({ id: 'c', path: 'gpt-realtime/tools', testCall: false, runnerStalls: 0, events: [], refusals: [], agentLines: [], ...o });

  it('counts stalls, reply p50/p90, refusal loops and internal talk per path, from fixture events', () => {
    const turns = (gaps: number[]) => gaps.flatMap((g, i) => [ev('input_audio_buffer.speech_stopped', i * 20_000), ev('output_audio_buffer.started', i * 20_000 + g)]);
    const [path] = dailyNumbers([
      call({ id: 'a', events: turns([600, 900, 6200]), refusals: [{ tool: 'find_slots', code: 'fully_booked' }, { tool: 'find_slots', code: 'fully_booked' }, { tool: 'find_slots', code: 'fully_booked' }], agentLines: ['It is still running in the background.', 'Tuesday at 9 is free.'] }),
      call({ id: 'b', testCall: true, events: turns([1200, 800]), refusals: [{ tool: 'find_slots', code: 'fully_booked' }, { tool: 'verify_caller', code: 'not_found' }], agentLines: ['Biscuit is booked.'] }),
    ]);
    expect(path).toMatchObject({ path: 'gpt-realtime/tools', calls: 2, testCalls: 1, callsWithEventLog: 2 });
    expect(path!.stalls).toMatchObject({ status: 'measured', value: 1, callsMeasured: 2, source: 'event_log' });
    expect(path!.replyMs).toMatchObject({ status: 'measured', p50: 900, p90: 6200, n: 5, callsMeasured: 2 });
    expect(path!.refusalLoops).toMatchObject({ status: 'measured', value: 1, loops: [{ tool: 'find_slots', code: 'fully_booked', calls: 1 }] });
    expect(path!.internalTalk).toMatchObject({ status: 'measured', value: 1, callsMeasured: 2 });
  });

  it('says "not measured yet" with the reason, never a made-up number', () => {
    const paths = dailyNumbers([
      call({ id: 'l', path: 'gpt-live/planner', runnerStalls: 2, events: [ev('session.output_audio.delta', 900)], agentLines: null }),
      call({ id: 'v', path: 'vapi/tools', runnerStalls: null }),
    ]);
    const live = paths.find((p) => p.path === 'gpt-live/planner')!;
    expect(live.stalls).toMatchObject({ status: 'measured', value: 2, source: 'call_record' });
    expect(live.replyMs).toEqual({ status: 'not_measured', reason: expect.stringContaining('GPT-Live') });
    expect(live.yesDisagreements).toEqual({ status: 'not_measured', reason: expect.stringContaining('batch B') });
    expect(live.internalTalk).toEqual({ status: 'not_measured', reason: expect.stringContaining('retention') });
    const vapi = paths.find((p) => p.path === 'vapi/tools')!;
    expect(vapi.stalls.status).toBe('not_measured');
    expect(vapi.replyMs.status).toBe('not_measured');
    const text = formatDailyNumbers('numbers', paths).join('\n');
    expect(text).toContain('reply ms: not measured yet: GPT-Live');
    expect(text).not.toMatch(/NaN|undefined/);
  });

  it('reads a percentile by nearest rank', () => {
    expect(percentileOf([], 0.5)).toBeNull();
    expect(percentileOf([5, 1, 3], 0.5)).toBe(3);
    expect(percentileOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
  });
});

describe('the QA export masks numbers in transcripts and keeps the words (foundation A, item 1)', () => {
  it('masks phone numbers written or said, any run of 4+ digits, written dates and emails', () => {
    expect(maskQaLine('My number is 303-555-0147, or (720) 555 0199.')).toBe('My number is [number], or [number].');
    expect(maskQaLine('It is five five five, oh one four seven.')).toBe('It is [number].');
    expect(maskQaLine('The code is 4821 and my card ends 1234.')).toBe('The code is [number] and my card ends [number].');
    expect(maskQaLine('She was seen on 03/04/2025.')).toBe('She was seen on [date].');
    expect(maskQaLine('Write to maria@example.com please')).toBe('Write to [email] please');
  });

  it('keeps names, times and short numbers', () => {
    expect(maskQaLine('Maria Delgado, two dogs, Tuesday at 2:30, room 3.')).toBe('Maria Delgado, two dogs, Tuesday at 2:30, room 3.');
  });

  it('masks a date of birth on a birthday line and on the answer after the question', () => {
    expect(maskQaLine('Biscuit was born March 3rd, 2019.')).toBe('Biscuit was born [date].');
    expect(maskQaLine('His birthday is the 5th of May.')).toBe('His birthday is [date].');
    const lines = maskQaTranscript([{ speaker: 'agent', text: 'What is Biscuit\'s date of birth?' }, { speaker: 'caller', text: 'March 3rd' }, { speaker: 'caller', text: 'Book March 4th please' }]);
    expect(lines.map((l) => l.text)).toEqual(['What is Biscuit\'s date of birth?', '[date]', 'Book March 4th please']);
  });
});
