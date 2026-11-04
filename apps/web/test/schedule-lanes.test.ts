import { afterEach, describe, expect, it, vi } from 'vitest';
import { blockHeight, initials, laneProviders, MANY_PROVIDERS, MAX_CHOSEN, MIN_BLOCK, placeBlocks, PX, readChosen, worksOn, writeChosen } from '../lib/schedule-lanes';

const weekdays = { open: '08:00', close: '17:00' };
type Hours = Partial<Record<'0' | '1' | '2' | '3' | '4' | '5' | '6', { open: string; close: string }[]>>;
const clinic = { timezone: 'America/Chicago', hours: { '1': [weekdays], '2': [weekdays], '3': [weekdays], '4': [weekdays], '5': [weekdays] } as Hours, holidays: ['2026-11-26'], specialDays: [{ date: '2026-11-27', windows: [], note: 'Staff day' }] };
const vet = (n: number, extra: Partial<{ hours: Hours; timeOff: { from: string; to: string }[] }> = {}) =>
  ({ id: `prov_${n}`, name: `Dr. Vet ${String(n).padStart(3, '0')}`, timeOff: [], ...extra });
const many = Array.from({ length: 12 }, (_, i) => vet(i + 1));
const monday = '2026-11-02';
const sunday = '2026-11-01';

const stubStorage = () => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
  return store;
};

describe('who works on a date', () => {
  it('follows the clinic hours, their own hours, time off, holidays and closed special days', () => {
    expect(worksOn(clinic, vet(1), monday)).toBe(true);
    expect(worksOn(clinic, vet(1), sunday)).toBe(false);
    expect(worksOn(clinic, vet(2, { hours: { '0': [weekdays] } }), sunday)).toBe(true);
    expect(worksOn(clinic, vet(2, { hours: { '0': [weekdays] } }), monday)).toBe(false);
    expect(worksOn(clinic, vet(3, { timeOff: [{ from: monday, to: monday }] }), monday)).toBe(false);
    expect(worksOn(clinic, vet(1), '2026-11-26')).toBe(false);
    expect(worksOn(clinic, vet(1), '2026-11-27')).toBe(false);
  });
});

describe('the lanes a day draws', () => {
  it('are everyone at a clinic of a few providers, in the same order', () => {
    const few = many.slice(0, MANY_PROVIDERS);
    expect(laneProviders(clinic, few, [monday], [], [])).toBe(few);
    expect(laneProviders(clinic, few, [sunday], [], ['prov_9'])).toBe(few);
  });

  it('past that, are the ones with a visit that day or picked while working', () => {
    const lanes = laneProviders(clinic, many, [monday], ['prov_5', 'prov_5'], ['prov_2', 'prov_7']);
    expect(lanes.map((p) => p.id)).toEqual(['prov_2', 'prov_5', 'prov_7']);
  });

  it('keep someone with a visit on their day off, and drop someone picked who is not working', () => {
    const away = many.map((p) => (p.id === 'prov_3' ? vet(3, { timeOff: [{ from: monday, to: monday }] }) : p));
    expect(laneProviders(clinic, away, [monday], ['prov_3'], ['prov_4']).map((p) => p.id)).toEqual(['prov_3', 'prov_4']);
    expect(laneProviders(clinic, away, [monday], [], ['prov_3']).map((p) => p.id)).toEqual([]);
    expect(laneProviders(clinic, many, [sunday], [], ['prov_1'])).toEqual([]);
  });

  it('over a week, count a pick as working when they work any of its days', () => {
    const weekend = vet(20, { hours: { '6': [weekdays] } });
    expect(laneProviders(clinic, [...many, weekend], [monday, '2026-11-07'], [], ['prov_20']).map((p) => p.id)).toEqual(['prov_20']);
  });
});

describe('the picked lanes are kept per clinic in this browser', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('round trip, dropping ids no longer on the clinic and anything past the cap', () => {
    const store = stubStorage();
    writeChosen('clinic_a', ['prov_2', 'prov_gone', 'prov_1']);
    expect(store.get('attendra.schedule.vets.clinic_a')).toBe('["prov_2","prov_gone","prov_1"]');
    expect(readChosen('clinic_a', many)).toEqual(['prov_2', 'prov_1']);
    expect(readChosen('clinic_b', many)).toEqual([]);
    writeChosen('clinic_a', many.map((p) => p.id));
    expect(readChosen('clinic_a', many)).toHaveLength(MAX_CHOSEN);
    writeChosen('clinic_a', []);
    expect(store.has('attendra.schedule.vets.clinic_a')).toBe(false);
  });

  it('is empty when the browser keeps nothing, or keeps something else', () => {
    const off = () => { throw new Error('storage off'); };
    vi.stubGlobal('localStorage', { getItem: off, setItem: off, removeItem: off });
    expect(() => writeChosen('clinic_a', ['prov_1'])).not.toThrow();
    expect(readChosen('clinic_a', many)).toEqual([]);
    const store = stubStorage();
    store.set('attendra.schedule.vets.clinic_a', '{"not":"a list"}');
    expect(readChosen('clinic_a', many)).toEqual([]);
    store.set('attendra.schedule.vets.clinic_a', 'not json');
    expect(readChosen('clinic_a', many)).toEqual([]);
  });
});

describe('initials for a narrow lane', () => {
  it('skip the title and take two words', () => {
    expect(initials('Dr. Nkem Okafor')).toBe('NO');
    expect(initials('Dr Vet 001')).toBe('V0');
    expect(initials('Okafor')).toBe('O');
    expect(initials('our veterinarian')).toBe('OV');
  });
});

describe('visit blocks on the day grid', () => {
  const at = (id: string, start: number, minutes: number, status = 'booked') => ({ id, status, span: [start, start + minutes] as const });
  const place = (items: ReturnType<typeof at>[]) => Object.fromEntries(placeBlocks(items, (x) => x.span).map((p) => [p.item.id, [p.column, p.columns]]));

  it('draws every visit at least 24 pixels tall, and a 15-minute one as its length', () => {
    expect(blockHeight(540, 545)).toBe(MIN_BLOCK);
    expect(blockHeight(540, 550)).toBe(MIN_BLOCK);
    expect(blockHeight(540, 555)).toBeGreaterThanOrEqual(24);
    expect(15 * PX - blockHeight(540, 555)).toBeGreaterThanOrEqual(2);
  });

  it('keeps back-to-back 15-minute visits each in the whole lane, with nothing between them overlapping', () => {
    expect(place([at('a', 540, 15), at('b', 555, 15), at('c', 570, 30)])).toEqual({ a: [0, 1], b: [0, 1], c: [0, 1] });
  });

  it('puts visits at the same time side by side, the booked one first', () => {
    expect(place([at('cancelled', 600, 20, 'cancelled'), at('rebooked', 600, 20)])).toEqual({ rebooked: [0, 2], cancelled: [1, 2] });
    expect(place([at('a', 660, 30), at('b', 675, 30), at('later', 720, 15)])).toEqual({ a: [0, 2], b: [1, 2], later: [0, 1] });
  });

  it('puts short visits stretched to the minimum side by side when their blocks would meet', () => {
    expect(place([at('a', 480, 5), at('b', 485, 5), at('c', 490, 10)])).toEqual({ a: [0, 3], b: [1, 3], c: [2, 3] });
  });
});

describe('the view a person last chose', () => {
  it('opens on Day by default and remembers another choice in this browser', async () => {
    const { readView, writeView } = await import('../lib/schedule-lanes');
    const store = new Map<string, string>();
    Object.assign(globalThis, { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) } });
    expect(readView('clinic_a')).toBe('day');
    writeView('clinic_a', 'week');
    expect(readView('clinic_a')).toBe('week');
    expect(readView('clinic_b')).toBe('day');
    store.set('attendra.schedule.view.clinic_a', 'nonsense');
    expect(readView('clinic_a')).toBe('day');
  });
});
