// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { TestCallNumbers } from '@attendra/api/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Check, Search } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useSettled } from '@/components/patients/patient-search';
import { Input, Label, Select } from '@/components/ui/input';
import { PhoneInput } from '@/components/ui/phone-input';
import { api } from '@/lib/api';
import { type CallAs, NO_CALLER_ID } from '@/lib/call-as';
import { cn } from '@/lib/utils';

type Mode = CallAs['kind'];

/**
 * "Call as" for a browser test call: no caller ID (as before), a number from the clinic's
 * records, or one typed. The assistant then treats it as the call's caller ID, as on a
 * phone call: it reads that number's earlier calls and record. The call stays a browser
 * test: no transfers, and no texts. The records show only the owner's first name and the
 * last four digits; the whole number never reaches this page, the API reads it.
 *
 * `onChange` gets the choice, or null while it is not finished (no record picked, no whole
 * number typed). While a call is live, `calledAsLast4` (from the server) is shown instead.
 */
export function CallAsPicker({ clinicId, canReadRecords, onChange, live, calledAsLast4 }: {
  clinicId: string;
  /** patients:read: a number from the records is offered only then. */
  canReadRecords: boolean;
  onChange: (callAs: CallAs | null) => void;
  live: boolean;
  calledAsLast4: string | null;
}) {
  const id = useId();
  const [mode, setMode] = useState<Mode>('none');
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<{ patientId: string; label: string } | null>(null);
  const [typed, setTyped] = useState('');
  const q = useSettled(text.trim());
  const numbers = useQuery({
    queryKey: ['test-call-numbers', clinicId, q],
    queryFn: () => api<TestCallNumbers>(`/clinics/${clinicId}/test-calls/numbers`, { method: 'POST', body: JSON.stringify({ q }) }),
    enabled: mode === 'record' && canReadRecords,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
  });

  useEffect(() => {
    if (mode === 'none') onChange(NO_CALLER_ID);
    else if (mode === 'record') onChange(picked ? { kind: 'record', patientId: picked.patientId } : null);
    // the server reads it the clinic's way and refuses anything that is not a whole number
    else onChange(typed.replace(/\D/g, '').length >= 7 ? { kind: 'typed', number: typed } : null);
  }, [mode, picked, typed, onChange]);

  if (live) {
    return calledAsLast4
      ? <p className="text-sm font-medium" data-testid="calling-as">Calling as …{calledAsLast4}</p>
      : null;
  }

  return (
    <div className="w-full space-y-2 text-left">
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-mode`}>Call as</Label>
        <Select id={`${id}-mode`} value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
          <option value="none">No caller ID</option>
          {canReadRecords && <option value="record">A number from your records</option>}
          <option value="typed">Type a number</option>
        </Select>
        <p className="text-xs text-text-muted">
          {mode === 'none' ? 'The assistant asks for a number when it needs one.' : 'The assistant treats it as the caller ID, as on a phone call. Still a test: no transfers, no texts.'}
        </p>
      </div>
      {mode === 'record' && (
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-find`} className="sr-only">Find a number in your records</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-muted" aria-hidden />
            <Input id={`${id}-find`} type="search" autoComplete="off" spellCheck={false} className="pl-9" value={text}
              onChange={(e) => setText(e.target.value)} placeholder="Owner name or last digits" />
          </div>
          {numbers.isError ? <p className="text-sm text-danger">The records could not be read. Try again in a moment.</p>
            : numbers.data && !numbers.data.numbers.length ? <p className="text-sm text-text-muted">No number matches.</p>
              : (
                <ul role="listbox" aria-label="Numbers from your records" aria-busy={numbers.isFetching} className="max-h-48 divide-y divide-border overflow-y-auto rounded-md border border-border">
                  {numbers.data?.numbers.map((n) => {
                    const selected = picked?.patientId === n.patientId;
                    return (
                      <li key={n.patientId} role="option" aria-selected={selected} tabIndex={0}
                        onClick={() => setPicked(n)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPicked(n); } }}
                        className={cn('focus-ring flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm hover:bg-surface-sunken', selected && 'font-medium')}>
                        {n.label}{selected && <Check className="size-4 text-primary" aria-hidden />}
                      </li>
                    );
                  })}
                </ul>
              )}
        </div>
      )}
      {mode === 'typed' && (
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-number`} className="sr-only">Number to call as</Label>
          <PhoneInput id={`${id}-number`} value={typed} onValue={setTyped} placeholder="(555) 555-0123" autoComplete="off" />
        </div>
      )}
    </div>
  );
}
