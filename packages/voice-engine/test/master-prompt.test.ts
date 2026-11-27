import { DEMO_CLINIC, RIVERBEND_CLINIC } from '@attendra/core';
import { describe, expect, it } from 'vitest';
import { MASTER_HEADER, masterLines, PATH_A_CUTS, PATH_A_DROPS, REPLACED_BY_MASTER, talkLines, toolsBackendInstructions, toolsLivePrompt, toolsVapiPrompt, toolsVoicePrompt, toolsVoiceStaticPrompt } from '../src';

// Step 4 (master prompt robustness): ONE master block, the same words on every voice that calls the tools.
const clinics = [{ ...RIVERBEND_CLINIC, voiceFlow: 'tools' as const }, { ...DEMO_CLINIC, voiceFlow: 'tools' as const }];
const block = masterLines().join('\n');

describe('MP: one master block on both call paths', () => {
  it('MP: path A\'s static prompt, the Vapi prompt and GPT-Live\'s voice carry the master block word for word; path A\'s drops and cuts leave it whole', () => {
    for (const c of clinics) {
      for (const prompt of [toolsVoiceStaticPrompt(c), toolsVapiPrompt(c), toolsVoicePrompt(c), toolsLivePrompt(c)]) expect(prompt).toContain(block);
      for (const line of masterLines()) {
        expect(PATH_A_DROPS.some((d) => d.test(line)), line).toBe(false);
        expect(PATH_A_CUTS.every(([cut]) => line.replace(cut, '') === line), line).toBe(true);
      }
    }
  });

  it('MP: the block is the same on every call (no caller ID, no date), covers each part of step 4, and the lines it replaces are gone from the tools-path voices', () => {
    expect(toolsVoiceStaticPrompt(clinics[0]!)).toBe(toolsVoiceStaticPrompt(clinics[0]!));
    expect(block).not.toMatch(/\d{4}-\d{2}-\d{2}|ending \d{4}/);
    for (const part of [MASTER_HEADER, 'Scope:', 'Truth:', 'Medical:', 'About you:', 'Privacy:', 'Hard calls:', 'Style:']) expect(block).toContain(part);
    for (const rule of ['send the caller to the clinic', 'internal state', 'the one just booked', 'other clinics', 'staff\'s personal details', 'one warning', 'Can you hear me?', 'confirm it before using it', 'number on file', 'play a role', 'one question at a time']) expect(block, rule).toContain(rule);
    for (const old of REPLACED_BY_MASTER) {
      expect(talkLines(undefined, 'vet').some((l) => old.test(l)), String(old)).toBe(true); // still a real line elsewhere (the planner path)
      for (const c of clinics) for (const prompt of [toolsVoiceStaticPrompt(c), toolsVapiPrompt(c)]) expect(prompt.split('\n').some((l) => old.test(l)), String(old)).toBe(false);
    }
    // the backend of GPT-Live writes the words: it keeps its own lines
    expect(toolsBackendInstructions(clinics[0]!)).toContain('Never mention a tool, a backend');
  });
});
