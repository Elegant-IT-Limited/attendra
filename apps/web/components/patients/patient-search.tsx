// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { PatientCard, PatientList } from '@attendra/api/contracts';
import { countryCopy, localDateOf } from '@attendra/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useParams } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/feedback';
import { Input, Label } from '@/components/ui/input';
import { shownValue } from '@/components/patients/custom-fields';
import { Badge } from '@/components/ui/badge';
import { api, useClinicConfig } from '@/lib/api';
import { age, dob, GENDER_LABEL, phone } from '@/lib/format';
import { usePets } from '@/lib/terms';

/** A short pause after each key, so a fast typist sends one request, not ten. Short enough to feel instant. */
export function useSettled<T>(value: T, ms = 150) {
  const [settled, setSettled] = useState(value);
  useEffect(() => { const t = setTimeout(() => setSettled(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return settled;
}

/**
 * Search as you type, from the first character: the start of a name ("m" finds every
 * Maria), any digits of a phone number ("017"), or a whole date of birth. What is
 * typed goes in a POST body and stays in this component: never in the address bar,
 * never in a log.
 */
export function PatientSearch({ clinicId, onPick, renderResult, autoFocus, empty, status }: {
  clinicId: string;
  onPick?: (p: PatientCard) => void;
  /** Render each result yourself, as a link for example. */
  renderResult?: (p: PatientCard) => ReactNode;
  autoFocus?: boolean;
  /** What to show before anything is typed. */
  empty?: ReactNode;
  /** new: only patients the assistant added that nobody has checked yet. */
  status?: 'new';
}) {
  const [text, setText] = useState('');
  const config = useClinicConfig(clinicId);
  const copy = countryCopy({ phoneNumbers: config.data?.phoneNumbers ?? [] });
  const pets = usePets(clinicId);
  const hint = pets
    ? `Results show as you type: a few letters of the pet's or the owner's name, a few digits of a phone number, or a birthday like ${copy.exampleDob}.`
    : `Results show as you type: a few letters of a name, a few digits of a phone number, or a date of birth like ${copy.exampleDob}.`;
  const query = useSettled(text.trim());
  const ready = query.length >= 1;
  const results = useQuery({
    queryKey: ['patient-search', clinicId, query, status ?? 'all'],
    queryFn: () => api<PatientList>(`/clinics/${clinicId}/patients/search`, { method: 'POST', body: JSON.stringify({ query, ...(status ? { status } : {}) }) }),
    enabled: ready,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
  });

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="patient-search">{pets ? 'Find a pet' : 'Find a patient'}</Label>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-muted" aria-hidden />
          <Input id="patient-search" type="search" autoComplete="off" spellCheck={false} autoFocus={autoFocus} className="pl-9" value={text}
            onChange={(e) => setText(e.target.value)} placeholder={pets ? 'Pet or owner name, phone, or birthday' : 'Name, date of birth, or phone number'} />
        </div>
        <p className="text-xs text-text-muted">{hint}</p>
      </div>
      {!text.trim() ? empty : results.isPending ? <Skeleton className="h-24" /> : results.isError ? (
        <p className="text-sm text-danger">The search did not work. Try again in a moment.</p>
      ) : !results.data?.patients.length ? (
        <p className="text-sm text-text-muted">{pets ? 'No pet matches. Check the spelling, or add it as a new pet.' : 'No patient matches. Check the spelling, or add them as a new patient.'}</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border" aria-label={pets ? 'Matching pets' : 'Matching patients'} aria-busy={results.isFetching}>
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
      {ready && (results.data?.truncated || results.data?.patients.length === 25) && <p className="text-xs text-text-muted">Showing the first 25 matches; type more to narrow them down.</p>}
    </div>
  );
}

export function PatientLine({ p }: { p: PatientCard }) {
  // always shown inside a clinic's pages: its age is counted on the clinic's date
  const { clinicId } = useParams<{ clinicId: string }>();
  const config = useClinicConfig(clinicId);
  return (
    <>
      <span className="min-w-0">
        <span className="flex items-center gap-2 truncate font-medium">{p.name}{p.status === 'new' && <Badge tone="warn">New, check details</Badge>}</span>
        <span className="block text-xs text-text-muted">
          {p.species
            // a pet: what kind of animal, and whose
            ? `${p.species.charAt(0).toUpperCase()}${p.species.slice(1)}${p.gender && p.gender !== 'undisclosed' ? `, ${(GENDER_LABEL[p.gender] ?? p.gender).toLowerCase()}` : ''}, born ${dob(p.dob)}, age ${age(p.dob, localDateOf(new Date(), config.data?.timezone ?? 'UTC'))}${p.guardianName ? `, owner ${p.guardianName}` : ''}`
            : <>{p.gender ? `${GENDER_LABEL[p.gender]}, born` : 'Born'} {dob(p.dob)}, age {age(p.dob, localDateOf(new Date(), config.data?.timezone ?? 'UTC'))}{p.guardianName ? `, parent or guardian ${p.guardianName}` : ''}</>}
        </span>
        {/* the clinic's own fields it chose to show as columns (Settings, Fields and lists) */}
        {(() => {
          const shownFields = (config.data?.customFields ?? []).filter((f) => f.column && p.custom?.[f.id]);
          return shownFields.length ? <span className="block text-xs text-text-muted">{shownFields.map((f) => `${f.label}: ${shownValue(f, p.custom[f.id])}`).join(' · ')}</span> : null;
        })()}
      </span>
      {p.phone ? <span className="shrink-0 text-xs tabular-nums text-text-muted">{phone(p.phone)}</span> : <Badge tone="danger">No phone</Badge>}
    </>
  );
}
