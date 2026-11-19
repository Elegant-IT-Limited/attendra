// SPDX-License-Identifier: AGPL-3.0-only
import { ClinicConfig, DEMO_CLINIC } from '@attendra/core';
import { describe, expect, it } from 'vitest';
import { TOOL_ACKS, vapiAssistant, vapiAssistantHash, VAPI_ACK_TOOLS } from '../src/vapi';

// Call speed on Vapi (2026-11-19): the caller's final transcripts come to us before Vapi's model runs (lookup-ahead), and
// a lookup says a short line in the call's language while it runs, instead of Vapi's longer default lines.
const input = { serverUrl: 'https://voice.example.test/webhooks/vapi/v1/events', secret: 's' };
const bilingual = ClinicConfig.parse({ ...DEMO_CLINIC, languages: ['en', 'es'], primaryLanguage: 'en' });

describe('the Vapi assistant, for speed', () => {
  it('asks for the caller\'s final transcripts', () => {
    expect(vapiAssistant(DEMO_CLINIC, input).serverMessages).toContain('transcript[transcriptType="final"]');
  });

  it('gives each lookup two short lines in each of the clinic\'s languages, and nothing to a tool that is not a lookup', () => {
    const tools = vapiAssistant(bilingual, input).model.tools as { function: { name: string }; messages?: { type: string; blocking: boolean; contents: { text: string; language: string }[] }[] }[];
    const find = tools.find((t) => t.function.name === 'find_slots')!;
    expect(find.messages).toEqual([
      { type: 'request-start', blocking: false, contents: [{ type: 'text', text: TOOL_ACKS.en[0], language: 'en' }, { type: 'text', text: TOOL_ACKS.es[0], language: 'es' }] },
      { type: 'request-start', blocking: false, contents: [{ type: 'text', text: TOOL_ACKS.en[1], language: 'en' }, { type: 'text', text: TOOL_ACKS.es[1], language: 'es' }] },
    ]);
    for (const t of tools) expect(!!t.messages).toBe(VAPI_ACK_TOOLS.has(t.function.name));
    expect(tools.find((t) => t.function.name === 'end_call')?.messages).toBeUndefined();
    // every line is one to three words
    for (const l of [...TOOL_ACKS.en, ...TOOL_ACKS.es]) expect(l.split(' ').length).toBeLessThanOrEqual(3);
  });

  it('gives none to a clinic that turned acknowledgements off', () => {
    const quiet = ClinicConfig.parse({ ...DEMO_CLINIC, talk: { pace: 'normal', style: 'warm', acknowledgements: false } });
    const tools = vapiAssistant(quiet, input).model.tools as { messages?: unknown }[];
    expect(tools.every((t) => t.messages === undefined)).toBe(true);
  });

  it('an assistant made before this is out of sync, so the deploy\'s re-sync takes it', () => {
    const now = vapiAssistant(DEMO_CLINIC, input);
    const before = { ...now, serverMessages: ['conversation-update', 'end-of-call-report', 'status-update'], model: { ...now.model, tools: (now.model.tools as Record<string, unknown>[]).map(({ messages: _m, ...t }) => t) } };
    expect(vapiAssistantHash(before as never)).not.toBe(vapiAssistantHash(now));
  });
});
