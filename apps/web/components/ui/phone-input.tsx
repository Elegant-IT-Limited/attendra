// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { cleanPhoneTyping, PHONE_NUMBERS_ONLY } from '@attendra/core';
import { type ComponentProps, useId, useState } from 'react';
import { Input } from '@/components/ui/input';

/**
 * Every phone field: numbers and the phone characters only (a leading +, spaces, -, (, ), .). Letters typed or pasted
 * are dropped as they come, and a short note under the field says so, never silently. The server refuses them too.
 */
export function PhoneInput({ value, onValue, 'aria-describedby': describedBy, ...props }: Omit<ComponentProps<'input'>, 'type' | 'onChange' | 'value'> & {
  value: string;
  /** The cleaned value, as typed. */
  onValue: (value: string) => void;
}) {
  const noteId = useId();
  const [note, setNote] = useState(false);
  const take = (typed: string) => {
    const { value: clean, dropped } = cleanPhoneTyping(typed);
    setNote(dropped);
    onValue(clean);
  };
  return (
    <>
      <Input {...props} type="tel" inputMode="tel" autoComplete={props.autoComplete ?? 'tel'} value={value}
        aria-describedby={[describedBy, note ? noteId : null].filter(Boolean).join(' ') || undefined}
        onChange={(e) => take(e.target.value)} />
      {note && <p id={noteId} role="status" className="text-xs text-warning">{PHONE_NUMBERS_ONLY}</p>}
    </>
  );
}
