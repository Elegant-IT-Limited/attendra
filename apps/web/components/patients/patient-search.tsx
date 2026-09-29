// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { PatientCard, PatientList } from '@attendra/api/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/feedback';
import { Input, Label } from '@/components/ui/input';
import { api, ApiFailure } from '@/lib/api';
import { age, dob, phone } from '@/lib/format';

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
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input id="patient-search" type="search" autoComplete="off" spellCheck={false} autoFocus={autoFocus} className="pl-9" value={text}
            onChange={(e) => setText(e.target.value)} placeholder="Name, date of birth, or phone number" />
        </div>
        <p className="text-xs text-muted-foreground">For example Delgado, 03/04/1985 or (303) 555-0147.</p>
      </div>
      {!ready ? empty : results.isPending ? <Skeleton className="h-24" /> : unreadable ? (
        <p className="text-sm text-muted-foreground">Type a name, a whole date of birth, or all ten digits of a phone number.</p>
      ) : results.isError ? (
        <p className="text-sm text-danger">The search did not work. Try again in a moment.</p>
      ) : !results.data?.patients.length ? (
        <p className="text-sm text-muted-foreground">No patient matches. Check the spelling, or add them as a new patient.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border" aria-label="Matching patients" aria-busy={results.isFetching}>
          {results.data.patients.map((p) => (
            <li key={p.id}>
              {renderResult ? renderResult(p) : (
                <button type="button" onClick={() => onPick?.(p)} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none">
                  <PatientLine p={p} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {ready && (results.data?.truncated || results.data?.patients.length === 25) && <p className="text-xs text-muted-foreground">Showing the first matches; type more of the name.</p>}
    </div>
  );
}

export function PatientLine({ p }: { p: PatientCard }) {
  return (
    <>
      <span className="min-w-0">
        <span className="block truncate font-medium">{p.name}</span>
        <span className="block text-xs text-muted-foreground">Born {dob(p.dob)}, age {age(p.dob)}</span>
      </span>
      {p.phone && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{phone(p.phone)}</span>}
    </>
  );
}
