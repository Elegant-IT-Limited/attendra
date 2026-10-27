import { afterEach, describe, expect, it, vi } from 'vitest';
import { clinicToOpen, rememberClinic } from '../lib/last-clinic';

const clinics = [{ id: 'clinic_a' }, { id: 'clinic_b' }];
const stubStorage = () => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
  return store;
};

describe('the clinic home opens', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('the one last opened in this browser', () => {
    const store = stubStorage();
    rememberClinic('clinic_b');
    expect(store.get('attendra.lastClinic')).toBe('clinic_b');
    expect(clinicToOpen(clinics)?.id).toBe('clinic_b');
  });

  it('the first, when the last one is no longer theirs, or none was kept', () => {
    stubStorage();
    expect(clinicToOpen(clinics)?.id).toBe('clinic_a');
    rememberClinic('clinic_gone');
    expect(clinicToOpen(clinics)?.id).toBe('clinic_a');
    expect(clinicToOpen([])).toBeUndefined();
  });

  it('the first, when the browser keeps nothing', () => {
    const off = () => { throw new Error('storage off'); };
    vi.stubGlobal('localStorage', { getItem: off, setItem: off, removeItem: off });
    expect(() => rememberClinic('clinic_b')).not.toThrow();
    expect(clinicToOpen(clinics)?.id).toBe('clinic_a');
  });
});
