import { describe, expect, it } from 'vitest';
import { saysSlot, zonedInstant } from '../src';

// Batch 1c: a booking counts as read back only when the assistant's words carry its day and time (a live run booked
// on a "Sí" that came after "I found Biscuit").
const TZ = 'America/Denver';
const NOW = zonedInstant('2026-09-28', '10:00', TZ); // a Monday
const FRI_530 = zonedInstant('2026-10-02', '17:30', TZ);
const TUE_9 = zonedInstant('2026-09-29', '09:00', TZ);
const MON_1440 = zonedInstant('2026-09-28', '14:40', TZ);

describe('saysSlot: the day and the time, in digits or words, EN and ES', () => {
  it('reads the usual read-backs', () => {
    expect(saysSlot('Friday, October 2, at 5:30 PM with Dr. Mara Vance for a sick visit?', FRI_530, TZ, NOW)).toBe(true);
    expect(saysSlot('el viernes 2 de octubre a las 5:30 de la tarde con Dra. Mara Vance', FRI_530, TZ, NOW)).toBe(true);
    expect(saysSlot('That\'s Friday at five thirty with Dr. Vance.', FRI_530, TZ, NOW)).toBe(true);
    expect(saysSlot('el viernes a las cinco y media', FRI_530, TZ, NOW)).toBe(true);
    expect(saysSlot('Tuesday at 9 AM', TUE_9, TZ, NOW)).toBe(true);
    expect(saysSlot('Tomorrow at nine o\'clock', TUE_9, TZ, NOW)).toBe(true);
    expect(saysSlot('mañana a las 9:00 de la mañana', TUE_9, TZ, NOW)).toBe(true);
    expect(saysSlot('today at 2:40 PM', MON_1440, TZ, NOW)).toBe(true);
  });

  it('is not said by other words, a wrong time or a wrong day', () => {
    expect(saysSlot('Gracias, Jordan. Encontré a Biscuit, su perro.', FRI_530, TZ, NOW)).toBe(false);
    expect(saysSlot('Thanks, Jordan. I found Biscuit, your dog.', FRI_530, TZ, NOW)).toBe(false);
    expect(saysSlot('Friday at 5:00 PM', FRI_530, TZ, NOW)).toBe(false);
    expect(saysSlot('Thursday at 5:30 PM', FRI_530, TZ, NOW)).toBe(false);
    expect(saysSlot('at 5:30 PM', FRI_530, TZ, NOW)).toBe(false);
    // "de la mañana" is the morning, not tomorrow
    expect(saysSlot('a las 9:00 de la mañana', TUE_9, TZ, NOW)).toBe(false);
    // 11:00 is not 1:00
    expect(saysSlot('Friday at 11:30', zonedInstant('2026-10-02', '13:30', TZ), TZ, NOW)).toBe(false);
  });
});
