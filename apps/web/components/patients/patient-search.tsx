// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { PatientCard, PatientList } from '@attendra/api/contracts';
import { countryCopy } from '@attendra/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/feedback';
import { Input, Label } from '@/components/ui/input';
import { api, ApiFailure, useClinicConfig } from '@/lib/api';
import { age, dob, phone, tenDigitPhones } from '@/lib/format';

/** Waits until typing pauses, so each keystroke is not a request. */
function useSettled(value: string, ms = 300) {
  const [settled, setSettled] = useState(value);
  useEffect(() => { const t = setTimeout(() => setSettled(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return settled;
}

/**
 * Search by name, date of birth or full phone number. What is typed goes in a POST
 * body and stays in this component: never in the address bar, never in a log.
 */
export function PatientSearch({ clinicId, onPick, renderResult, autoFocus, empty }: {
  clinicId: string;
  onPick?: (p: PatientCard) => void;
  /** Render each result yourself, as a link for example. */
  renderResult?: (p: PatientCard) => ReactNode;
  autoFocus?: boolean;
  /** What to show before anything is typed. */
  empty?: ReactNode;
}) {
  const [text, setText] = useState('');
  const config = useClinicConfig(clinicId);
  const copy = countryCopy({ phoneNumbers: config.data?.phoneNumbers ?? [] });
  const hint = `For example a last name, ${copy.exampleDob}${copy.phone.local ? ` or ${copy.phone.local}` : ''}.`;
  const query = useSettled(text.trim());
  const ready = query.length >= 2;
  const results = useQuery({
    queryKey: ['patient-search', clinicId, query],
    queryFn: () => api<PatientList>(`/clinics/${clinicId}/patients/search`, { method: 'POST', body: JSON.stringify({ query }) }),
    enabled: ready,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
  });
  const unreadable = results.error instanceof ApiFailure && results.error.status === 422;

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="patient-search">Find a patient</Label>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-muted" aria-hidden />
          <Input id="patient-search" type="search" autoComplete="off" spellCheck={false} autoFocus={autoFocus} className="pl-9" value={text}
            onChange={(e) => setText(e.target.value)} placeholder="Name, date of birth, or phone number" />
        </div>
        <p className="text-xs text-text-muted">{hint}</p>
      </div>
      {!ready ? empty : results.isPending ? <Skeleton className="h-24" /> : unreadable ? (
        <p className="text-sm text-text-muted">Type a name, a whole date of birth, or {tenDigitPhones() ? 'all ten digits of a phone number' : 'a whole phone number'}.</p>
      ) : results.isError ? (
        <p className="text-sm text-danger">The search did not work. Try again in a moment.</p>
      ) : !results.data?.patients.length ? (
        <p className="text-sm text-text-muted">No patient matches. Check the spelling, or add them as a new patient.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border" aria-label="Matching patients" aria-busy={results.isFetching}>
          {results.data.patients.map((p) => (
            <li key={p.id}>
              {renderResult ? renderResult(p) : (
                <button type="button" onClick={() => onPick?.(p)} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:outline-none">
                  <PatientLine p={p} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {ready && (results.data?.truncated || results.data?.patients.length === 25) && <p className="text-xs text-text-muted">Showing the first matches; type more of the name.</p>}
    </div>
  );
}

export function PatientLine({ p }: { p: PatientCard }) {
  return (
    <>
      <span className="min-w-0">
        <span className="block truncate font-medium">{p.name}</span>
        <span className="block text-xs text-text-muted">Born {dob(p.dob)}, age {age(p.dob)}</span>
      </span>
      {p.phone && <span className="shrink-0 text-xs tabular-nums text-text-muted">{phone(p.phone)}</span>}
    </>
  );
}
