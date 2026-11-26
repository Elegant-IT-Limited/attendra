import { FILLER_PREAMBLES, opensWithFillerPreamble, RIVERBEND_CLINIC } from '@attendra/core';
import { describe, expect, it } from 'vitest';
import { toolsVapiPrompt, TURN_NOTE, TURN_NOTE_NO_ACK } from '../src';

// CQ2-R7 (call quality round 2, 2026-11-19): most replies opened with a preamble ("Let me check which vets are available
// and then we can go from there"). PR #191 banned the named preambles in the turn note; nothing tested it, and the Vapi
// prompt never named them.
const vet = { ...RIVERBEND_CLINIC, voiceFlow: 'tools' as const };
describe('CQ2-R7: the filler preambles are banned on both paths', () => {
  it('CQ2-R7: path A\'s turn note (with and without acknowledgements) and the Vapi prompt name every banned preamble', () => {
    expect(FILLER_PREAMBLES.length).toBeGreaterThanOrEqual(5);
    for (const p of FILLER_PREAMBLES) {
      expect(TURN_NOTE, p).toContain(`"${p}"`);
      expect(TURN_NOTE_NO_ACK, p).toContain(`"${p}"`);
      expect(toolsVapiPrompt(vet), p).toContain(`"${p}"`);
    }
  });

  it('CQ2-R7: a reply that opens with one is flagged, in English and Spanish; the same words later in a reply are not', () => {
    for (const s of ['Let me check which vets are available.', 'Okay, let me set that up.', 'Sure, I can help with that. Which day?', "I'll set that up and confirm the details.", 'Déjeme revisar.', 'Bueno, déjeme ver.', 'Permítame un momento, voy a revisar.'])
      expect(opensWithFillerPreamble(s), s).toBe(true);
    for (const s of ['Sure.', 'One moment.', 'Dr. Ruiz is free at 9.', "No problem, I haven't booked anything. Let me see what Thursday looks like.", 'Claro.', 'Un momento.'])
      expect(opensWithFillerPreamble(s), s).toBe(false);
  });
});
