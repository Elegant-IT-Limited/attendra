import { describe, expect, it } from 'vitest';
import { inProviderOrder, providerOrderAsked } from '../src';

// note 52 B8: a caller asked for the vets "from last to first" and heard them in the stored order
const vets = [{ name: 'Dr. Nora Blake' }, { name: 'Dr. Avery Quinn' }, { name: 'Dr. Lee Park' }];
const names = (order: Parameters<typeof inProviderOrder>[1]) => inProviderOrder(vets, order).map((v) => v.name);

describe('the vets in the order the caller asks for', () => {
  it('reads the order from the words, EN and ES', () => {
    expect(providerOrderAsked('Can you list your vets from last to first?')).toBe('reversed');
    expect(providerOrderAsked('read them backwards please')).toBe('reversed');
    expect(providerOrderAsked('Who are your vets, alphabetically?')).toBe('first_name');
    expect(providerOrderAsked('in order by last name')).toBe('last_name');
    expect(providerOrderAsked('Z to A')).toBe('first_name_desc');
    expect(providerOrderAsked('¿Me los dice del último al primero?')).toBe('reversed');
    expect(providerOrderAsked('por apellido')).toBe('last_name');
    expect(providerOrderAsked('Who are your vets?')).toBe('listed');
  });

  it('hands the list over in that order, never sorting on the title', () => {
    expect(names('listed')).toEqual(['Dr. Nora Blake', 'Dr. Avery Quinn', 'Dr. Lee Park']);
    expect(names('reversed')).toEqual(['Dr. Lee Park', 'Dr. Avery Quinn', 'Dr. Nora Blake']);
    expect(names('first_name')).toEqual(['Dr. Avery Quinn', 'Dr. Lee Park', 'Dr. Nora Blake']);
    expect(names('last_name')).toEqual(['Dr. Nora Blake', 'Dr. Lee Park', 'Dr. Avery Quinn']);
    expect(names('last_name_desc')).toEqual(['Dr. Avery Quinn', 'Dr. Lee Park', 'Dr. Nora Blake']);
  });
});
