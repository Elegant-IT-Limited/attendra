import { describe, expect, it } from 'vitest';
import { micCheck, micWarning } from '../lib/mic';

describe('the test call microphone check', () => {
  it('says nothing when the browser reports both on', () => {
    const check = micCheck({ echoCancellation: true, noiseSuppression: true });
    expect(check).toEqual({ off: [], unverified: [] });
    expect(micWarning(check)).toBeNull();
  });

  it('warns about echo first, since the assistant then hears itself', () => {
    const check = micCheck({ echoCancellation: false, noiseSuppression: false });
    expect(check.off).toEqual(['echoCancellation', 'noiseSuppression']);
    expect(micWarning(check)).toMatch(/did not turn on echo cancellation/);
  });

  it('warns about noise suppression on its own', () => {
    expect(micWarning(micCheck({ echoCancellation: true, noiseSuppression: false }))).toMatch(/did not turn on noise suppression/);
  });

  it('treats a setting the browser does not report as unverified, not as on', () => {
    const check = micCheck({});
    expect(check).toEqual({ off: [], unverified: ['echoCancellation', 'noiseSuppression'] });
    expect(micWarning(check)).toMatch(/did not say whether echo cancellation is on/);
    expect(micWarning(micCheck({ echoCancellation: true }))).toMatch(/did not say whether noise suppression is on/);
  });
});
