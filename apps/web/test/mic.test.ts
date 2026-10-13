import { describe, expect, it } from 'vitest';
import { micWarning, missingProcessing } from '../lib/mic';

describe('the test call microphone check', () => {
  it('finds nothing missing when the browser applied what we asked for', () => {
    expect(missingProcessing({ echoCancellation: true, noiseSuppression: true })).toEqual([]);
    expect(micWarning([])).toBeNull();
  });

  it('warns about echo first, since the assistant then hears itself', () => {
    const missing = missingProcessing({ echoCancellation: false, noiseSuppression: false });
    expect(missing).toEqual(['echoCancellation', 'noiseSuppression']);
    expect(micWarning(missing)).toMatch(/echo cancellation/);
  });

  it('warns about noise suppression on its own', () => {
    expect(micWarning(missingProcessing({ echoCancellation: true, noiseSuppression: false }))).toMatch(/noise suppression/);
  });

  it('does not warn when the browser does not report a setting', () => {
    expect(missingProcessing({})).toEqual([]);
  });
});
