import { describe, expect, it } from 'vitest';
import { shortLinkStep } from '../lib/short-links';

// QA-1109-2 (review 2026-11-26): where a short address goes for each answer /me gives.
describe('QA-1109-2: short addresses', () => {
  const clinics = [{ id: 'clinic_a' }, { id: 'clinic_b' }];
  it('QA-1109-2: signed out goes to sign-in with the page as next; signed in opens it in the clinic', () => {
    expect(shortLinkStep('calls', 401)).toEqual({ go: '/sign-in?next=%2Fcalls' });
    expect(shortLinkStep('calls', 200, clinics, 'clinic_b')).toEqual({ go: '/c/clinic_b/calls' });
    expect(shortLinkStep('today', 200, clinics, null)).toEqual({ go: '/c/clinic_a' });
    expect(shortLinkStep('calls', 200, [], null)).toEqual({ go: '/' });
    expect(shortLinkStep('calls', 503)).toEqual({ failed: true });
  });

  it('QA-1109-2: a password to change first (403) keeps the asked-for page for after it', () => {
    expect(shortLinkStep('schedule', 403)).toEqual({ go: '/', next: '/schedule' });
  });
});
