// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error a plain .mjs script, with no types of its own
import { checkLine, checkText, parseDenylist } from '../privacy-check.mjs';

// every string here is made up; the real list lives in a repository secret
const LIST = parseDenylist('# testers\nQuillon\nMarrowby Vets\n2125550877\n');

describe('the privacy check', () => {
  it('lets fictional 555-0100 to 555-0199 numbers through, in any spelling, and Twilio\'s test numbers', () => {
    for (const ok of ['+17205550161', '(720) 555-0161', '720-555-0161', '7205550161', '<sip:7205550161@pstn.twilio.com>', '+15005550006', 'call 911', '+447700900123', '+6495551234']) {
      expect(checkLine(ok), ok).toEqual([]);
    }
  });

  it('stops a number that could be someone\'s, however it is written', () => {
    for (const bad of ['+12125550877', '(212) 555-0877', '212.555.0877', '2125550877', '<sip:2125550877@pstn.twilio.com>', '+1 (212) 845-3321']) {
      expect(checkLine(bad), bad).toEqual(['a phone number outside 555-0100 to 555-0199']);
    }
  });

  it('stops the region rule\'s country code and any text in its script', () => {
    expect(checkLine('+447700900123 and +8 8 0 spaced out')).toEqual([]);
    expect(checkLine(`call +${'88'}01700000000`)).toEqual(['a word or code from the region rule']);
    expect(checkLine('\u09A8\u09AE\u09C1\u09A8\u09BE')).toEqual(['a word or code from the region rule']);
  });

  it('allows only made-up email domains and project ids', () => {
    expect(checkLine('dana@oakhill.example, sam@example.com, robin@maple-demo.test, 1+x@users.noreply.github.com')).toEqual([]);
    expect(checkLine('write to someone@realmail.net')).toEqual(['an email address outside the made-up domains']);
    expect(checkLine('<sip:proj_example@sip.api.openai.com>')).toEqual([]);
    expect(checkLine('<sip:proj_example@sip.notopenai.com>')).toEqual(['an email address outside the made-up domains']);
    expect(checkLine('<sip:proj_8hQ2xLm4Rt@sip.api.openai.com>')).toEqual(['an email address outside the made-up domains', 'a project id that is not made up']);
  });

  it('finds a denylisted word or number and names only its entry, never the word', () => {
    const found = checkText('notes.md', 'Fine.\nA call from quillon about MARROWBY VETS.\nDialled +1 212 555 0877.', LIST);
    expect(found).toEqual([
      'notes.md:2: denylisted entry #1',
      'notes.md:2: denylisted entry #2',
      'notes.md:3: a phone number outside 555-0100 to 555-0199',
      'notes.md:3: denylisted entry #3',
    ]);
    expect(found.join('\n').toLowerCase()).not.toMatch(/quillon|marrowby|0877/);
    // a whole word only: a name inside another word is not it
    expect(checkLine('Quillonesque', LIST)).toEqual([]);
  });

  it('runs the public rules with no private list, as on a fork\'s pull request', () => {
    const script = join(import.meta.dirname, '../privacy-check.mjs');
    const env = { ...process.env, PRIVACY_DENYLIST: '', PR_TITLE: 'Fix a thing', PR_BODY: 'Tested with +17205550161.' };
    const out = execFileSync('node', [script], { cwd: join(import.meta.dirname, '../..'), env, encoding: 'utf8' });
    expect(out).toContain('PRIVACY_DENYLIST is not set');
    expect(out).toMatch(/privacy: \d+ files clean/);
  });
});
