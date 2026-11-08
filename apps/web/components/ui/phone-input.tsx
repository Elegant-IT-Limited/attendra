// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { cleanPhoneField, PHONE_NUMBERS_ONLY, type PhoneTypingMode } from '@attendra/core';
import { type ComponentProps, useId, useState } from 'react';
import { Input } from '@/components/ui/input';

/**
 * Every phone field: numbers and the phone characters only (a leading +, spaces, -, (, ), .). Letters typed or pasted
 * are dropped as they come, and a short note under the field says so, never silently. The server refuses them too.
 *
 * `mode`: "several" for numbers separated by commas (each may start with +), "transfer" for a transfer target, which
 * may also be a SIP address (sip:…). autoComplete is "tel" by default: the person's own number. A field for someone
 * else's number (an owner, a vet, a hospital) passes "off", so the browser never fills in the staff member's own phone.
 */
export function PhoneInput({ value, onValue, mode = 'one', 'aria-describedby': describedBy, ...props }: Omit<ComponentProps<'input'>, 'type' | 'onChange' | 'value'> & {
  value: string;
  /** The cleaned value, as typed. */
  onValue: (value: string) => void;
  mode?: PhoneTypingMode;
}) {
  const noteId = useId();
  const [note, setNote] = useState(false);
  const take = (typed: string) => {
    const { value: clean, dropped } = cleanPhoneField(typed, mode);
    // shown from the first letter taken out until the field is emptied: the next digit typed must not hide it again
    if (dropped) setNote(true);
    else if (!clean.trim()) setNote(false);
    onValue(clean);
  };
  return (
    <>
      <Input maxLength={mode === 'several' ? 100 : 30} {...props} type="tel" inputMode="tel" autoComplete={props.autoComplete ?? 'tel'} value={value}
        aria-describedby={[describedBy, note ? noteId : null].filter(Boolean).join(' ') || undefined}
        onChange={(e) => take(e.target.value)} />
      {note && <p id={noteId} role="status" className="text-xs text-warning" data-testid="phone-note">{PHONE_NUMBERS_ONLY}</p>}
    </>
  );
}
