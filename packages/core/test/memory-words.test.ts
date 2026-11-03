import { describe, expect, it } from 'vitest';
import { extractFacts, resolveWeekday } from '../src';

// what a caller's own words say, by closed word lists: kept so nothing is asked twice (2026-11-14)
const MONDAY = '2026-11-02';
const en = (text: string, animals?: string[]) => extractFacts(text, 'en', { today: MONDAY, animals });
const es = (text: string) => extractFacts(text, 'es', { today: MONDAY });

describe('the kind of animal and its sex', () => {
  it('finds the animal after a word that points at it', () => {
    expect(en('Hi, my dog needs a check-up').species).toBe('dog');
    expect(en('my dog had a rough night').species).toBe('dog');
    expect(en('we just got a new puppy').species).toBe('dog');
    expect(es('Hola, mi perra necesita una revisión').species).toBe('dog');
    expect(es('es un gato').species).toBe('cat');
  });

  it('a correction replaces: the later one wins', () => {
    expect(en('my dog... no, sorry, it\'s a cat').species).toBe('cat');
    expect(es('mi perro... no, perdón, es un gato').species).toBe('cat');
  });

  it('"she" alone is not an animal, and says the sex only next to one', () => {
    expect(en('she needs a check-up')).toEqual({ intent: 'book' });
    expect(en('my cat, she is due for shots')).toMatchObject({ species: 'cat', sex: 'female' });
    expect(en('a female, about two')).toMatchObject({ sex: 'female' });
    expect(en('he is a male')).toMatchObject({ sex: 'male' });
    expect(es('es hembra')).toMatchObject({ sex: 'female' });
    expect(es('mi perrita')).toMatchObject({ species: 'dog', sex: 'female' });
  });

  it('a friend\'s dog is not the caller\'s', () => {
    expect(en("she's a friend's dog").species).toBeUndefined();
  });

  it('takes the clinic\'s own animals', () => {
    expect(en('my hedgehog needs his nails done', ['hedgehogs']).species).toBe('hedgehog');
  });
});

describe('age', () => {
  it.each([
    ['she is two years old', '2 years'],
    ['a 6 month old puppy', '6 months'],
    ['about a year old', '1 year'],
  ])('%s', (said, age) => expect(en(said).age).toBe(age));
  it('Spanish', () => {
    expect(es('tiene dos años').age).toBe('2 years');
    expect(es('un cachorro de 3 meses').age).toBe('3 months');
  });
});

describe('what the call is about', () => {
  it.each([
    ['I need to book a check-up', 'book'],
    ['can I move my appointment', 'move'],
    ['I need to reschedule', 'move'],
    ['I want to cancel the appointment', 'cancel'],
    ['I wanted to book, actually no, cancel it', 'cancel'],
  ])('%s', (said, intent) => expect(en(said).intent).toBe(intent));
  it('Spanish', () => {
    expect(es('quiero hacer una cita').intent).toBe('book');
    expect(es('quiero cambiar la cita').intent).toBe('move');
    expect(es('necesito cancelar la cita').intent).toBe('cancel');
  });
});

describe('the day', () => {
  it('today and tomorrow', () => {
    expect(en('can she come in today').day).toEqual({ date: MONDAY });
    expect(en('tomorrow works').day).toEqual({ date: '2026-11-03' });
    expect(es('mañana por la mañana').day).toEqual({ date: '2026-11-03' });
    expect(es('en la mañana').day).toBeUndefined();
  });

  it('"this Wednesday" is the coming one', () => {
    expect(en('this Wednesday').day).toEqual({ date: '2026-11-04' });
    expect(es('este miércoles').day).toEqual({ date: '2026-11-04' });
    expect(en('on Wednesday').day).toEqual({ date: '2026-11-04' });
  });

  it('"next Wednesday" said on a Monday could be either week', () => {
    expect(en('next Wednesday').day).toEqual({ either: ['2026-11-04', '2026-11-11'] });
    expect(es('el próximo miércoles').day).toEqual({ either: ['2026-11-04', '2026-11-11'] });
    expect(es('el miércoles que viene').day).toEqual({ either: ['2026-11-04', '2026-11-11'] });
  });

  it('"next Wednesday" said on a Thursday is the coming one', () => {
    expect(resolveWeekday('2026-11-05', 3, 'next')).toEqual({ date: '2026-11-11' });
    // and on a Wednesday, the one a week away
    expect(resolveWeekday('2026-11-04', 3, 'next')).toEqual({ date: '2026-11-11' });
    expect(resolveWeekday('2026-11-04', 3, 'this')).toEqual({ date: '2026-11-04' });
  });

  it('a date, this year or next', () => {
    expect(en('November 12th').day).toEqual({ date: '2026-11-12' });
    expect(es('el 12 de noviembre').day).toEqual({ date: '2026-11-12' });
    expect(en('January 5').day).toEqual({ date: '2027-01-05' });
  });

  it('a date of birth is not a day for a visit', () => {
    expect(en('this is Maria Delgado, born March 4th 1985').day).toBeUndefined();
    expect(en('her birthday is May 2').day).toBeUndefined();
    expect(es('nació el 4 de marzo de 2020').day).toBeUndefined();
  });

  it('"any day" clears the day; the later day said wins', () => {
    expect(en('the first available is fine').day).toBeNull();
    expect(en('Thursday, no, make it Friday').day).toEqual({ date: '2026-11-06' });
  });
});

describe('the time', () => {
  it.each([
    ['Wednesday at 5', { time: '17:00', mode: 'at' }],
    ['Wednesday 5:20', { time: '17:20', mode: 'at' }],
    ['around 9 am', { time: '09:00', mode: 'at' }],
    ['after 3', { time: '15:00', mode: 'after' }],
    ['make it 4:40', { time: '16:40', mode: 'at' }],
    ['at 10:30 in the morning', { time: '10:30', mode: 'at' }],
  ])('%s', (said, time) => expect(en(said).time).toEqual(time));

  it('Spanish', () => {
    expect(es('a las 5 de la tarde').time).toEqual({ time: '17:00', mode: 'at' });
    expect(es('después de las 3').time).toEqual({ time: '15:00', mode: 'after' });
  });

  it('a number that is not a time is not one', () => {
    expect(en('she is 2 years old').time).toBeUndefined();
    expect(en('my number is 303-555-0142').time).toBeUndefined();
    expect(en('I have 2 dogs').time).toBeUndefined();
  });
});

describe('any vet', () => {
  it('"any family doctor is fine" lets go of a vet named before', () => {
    expect(en('And for me, any family doctor is fine.').anyVet).toBe(true);
    expect(es('con cualquier veterinario').anyVet).toBe(true);
    expect(en('with Dr. Ruiz please').anyVet).toBeUndefined();
  });
});
