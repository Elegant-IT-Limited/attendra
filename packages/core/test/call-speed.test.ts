// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { callSpeed, formatCallSpeed, turnSpeeds } from '../src/call-speed';

// Call speed (2026-11-19): the owner's target, read from the event log only: reply start median under 1.5 s and 90%
// under 2.5 s on each path, and the answer after a lookup alongside it.
const e = (atMs: number, type: string) => ({ atMs, type });

describe('call speed from the event log', () => {
  it('times each reply from the caller stopping, an acknowledgement included, and the answer after a lookup from the last reply of the turn', () => {
    const t = turnSpeeds([
      e(1000, 'input_audio_buffer.speech_started'), e(3000, 'input_audio_buffer.speech_stopped'),
      e(3900, 'output_audio_buffer.started'),
      e(6000, 'input_audio_buffer.speech_started'), e(8000, 'input_audio_buffer.speech_stopped'),
      e(8600, 'turn.ack'), e(9100, 'output_audio_buffer.started'), e(9300, 'lookahead.verify_caller'), e(10200, 'output_audio_buffer.started'),
      e(14000, 'input_audio_buffer.speech_started'), e(15000, 'input_audio_buffer.speech_stopped'),
      e(15800, 'response.function_call_arguments.done'), e(17400, 'output_audio_buffer.started'),
    ]);
    expect(t).toEqual({ reply: [900, 1100, 2400], answer: [2200, 2400], lookahead: 1, acks: 1 });
  });

  it('a turn the caller spoke again in before any reply has no reply time', () => {
    expect(turnSpeeds([e(1000, 'input_audio_buffer.speech_stopped'), e(1500, 'input_audio_buffer.speech_started'), e(3000, 'input_audio_buffer.speech_stopped'), e(4000, 'output_audio_buffer.started')]).reply).toEqual([1000]);
  });

  it('reads Vapi\'s turn events the same way, per path, and says whether the target is met', () => {
    const paths = callSpeed([
      { path: 'gpt-realtime/tools', events: [e(0, 'input_audio_buffer.speech_stopped'), e(1200, 'output_audio_buffer.started')] },
      { path: 'vapi/tools', events: [e(0, 'vapi.caller.stopped'), e(1400, 'vapi.tool_calls'), e(1300, 'vapi.assistant.started'), e(3000, 'vapi.assistant.started')] },
      { path: 'vapi/tools', events: [e(0, 'vapi.caller.stopped'), e(2900, 'vapi.assistant.started')] },
    ]);
    expect(paths.map((p) => [p.path, p.reply.p50, p.reply.p90, p.met])).toEqual([['gpt-realtime/tools', 1200, 1200, true], ['vapi/tools', 1300, 2900, false]]);
    expect(paths[1]!.answer).toEqual({ n: 1, p50: 3000, p90: 3000 });
    const text = formatCallSpeed(paths).join('\n');
    expect(text).toContain('gpt-realtime/tools: 1 calls, 1 replies timed');
    expect(text).toContain('target median < 1.5 s and p90 < 2.5 s: NOT MET');
  });
});
