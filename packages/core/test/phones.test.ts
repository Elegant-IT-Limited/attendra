import { describe, expect, it } from 'vitest';
import { asE164, formatPhone, providerPhoneIssues, samePhone, vipRoute, withPhonesAsE164, DEMO_CLINIC } from '../src';

const US = { phoneNumbers: ['+13035550100'] };
const CA = { phoneNumbers: ['+14165550100'] };
const UK = { phoneNumbers: ['+442079460123'] };
const AU = { phoneNumbers: ['+61291570123'] };
const NZ = { phoneNumbers: ['+6495550123'] };
const IE = { phoneNumbers: ['+35315550123'] };

describe('one phone number, however it is typed', () => {
  it('reads every way of writing a North American number as the same E.164', () => {
    const forms = ['5065550142', '(506) 555-0142', '506-555-0142', '+1 506 555 0142', '1 506 555 0142', '506.555.0142', '00 1 506 555 0142', 'tel:+15065550142', ' 506 555 0142 '];
    for (const clinic of [US, CA]) for (const typed of forms) expect(asE164(clinic, typed), typed).toBe('+15065550142');
    for (const a of forms) for (const b of forms) expect(samePhone(a, b, US), `${a} / ${b}`).toBe(true);
  });

  it('gives a national number the clinic\'s own country code', () => {
    expect(asE164(UK, '020 7946 0123')).toBe('+442079460123');
    expect(asE164(UK, '07700 900123')).toBe('+447700900123');
    expect(asE164(UK, '44 20 7946 0123')).toBe('+442079460123');
    expect(asE164(UK, '0044 20 7946 0123')).toBe('+442079460123');
    expect(asE164(IE, '01 555 0123')).toBe('+35315550123');
    expect(asE164(AU, '0491 570 123')).toBe('+61491570123');
    expect(asE164(NZ, '09 555 0123')).toBe('+6495550123');
  });

  it('keeps a number typed with its own country code in that country', () => {
    expect(asE164(UK, '+1 303 555 0142')).toBe('+13035550142');
    expect(asE164(UK, '001 303 555 0142')).toBe('+13035550142');
    expect(asE164(US, '+44 20 7946 0123')).toBe('+442079460123');
    // the same last digits in another country are another phone
    expect(samePhone('+13035550142', '+443035550142', UK)).toBe(false);
  });

  it('leaves a number that is not whole as it was given, and still compares it on its digits', () => {
    expect(asE164(US, '555-0142')).toBe('555-0142');
    expect(asE164(US, '+1 555')).toBe('+1 555');
    expect(samePhone('555-0142', '5550142', US)).toBe(true);
  });

  it('shows a number in the clinic\'s national format, and one from elsewhere internationally', () => {
    expect(formatPhone(US, '+15065550142')).toBe('(506) 555-0142');
    expect(formatPhone(US, '506 555 0142')).toBe('(506) 555-0142');
    expect(formatPhone(US, '+442079460123')).toBe('+44 20 7946 0123');
    expect(formatPhone(UK, '+442079460123')).toBe('020 7946 0123');
    expect(formatPhone(UK, '+447700900123')).toBe('07700 900123');
    expect(formatPhone(UK, '+15065550142')).toBe('+1 506 555 0142');
    expect(formatPhone(AU, '+61491570123')).toBe('0491 570 123');
    expect(formatPhone(US, '555-0142')).toBe('555-0142');
    expect(formatPhone(US, null)).toBe('');
  });

  it('puts every number in a clinic\'s settings in E.164 before they are checked', () => {
    const c = withPhonesAsE164({
      phoneNumbers: ['+13035550100'],
      vipCallers: [{ name: 'Partner vet', phone: '(303) 555-0177' }],
      emergencyHospital: { phone: '1 303 555 0188' },
      moreEmergencyHospitals: [{ phone: '303.555.0189' }],
      routing: [{ uri: 'tel:303-555-0190' }, { uri: 'sip:desk@example.com' }],
      providers: [{ phone: '303 555 0191', otherPhones: ['(303) 555-0192'] }],
    });
    expect(c.vipCallers![0]!.phone).toBe('+13035550177');
    expect(c.emergencyHospital!.phone).toBe('+13035550188');
    expect(c.moreEmergencyHospitals![0]!.phone).toBe('+13035550189');
    expect(c.routing!.map((r) => r.uri)).toEqual(['tel:+13035550190', 'sip:desk@example.com']);
    expect(c.providers![0]).toEqual({ phone: '+13035550191', otherPhones: ['+13035550192'] });
  });

  it('finds a VIP caller and a vet\'s number however either was written', () => {
    const clinic = { ...DEMO_CLINIC, vipCallers: [{ name: 'Partner vet', phone: '+13035550177' }] };
    const at = new Date('2026-11-03T16:00:00Z');
    expect(vipRoute(clinic, '1 (303) 555-0177', at)?.name ?? 'no route').not.toBe(null);
    const [vet] = DEMO_CLINIC.providers;
    const taken = { ...DEMO_CLINIC, industry: 'vet' as const, providers: [{ ...vet!, id: 'p_a', name: 'Dr Avery Lane', phone: '+13035550150' }] };
    expect(providerPhoneIssues(taken, { phone: '(303) 555-0150' }).issues).toEqual([{ path: 'phone', message: 'Dr. Avery Lane already has this number.' }]);
    expect(providerPhoneIssues(taken, { phone: '303 555 0151' }).phone).toBe('+13035550151');
  });
});
