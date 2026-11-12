// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { PatientCard, PatientList } from '@attendra/api/contracts';
import { countryCopy, localDateOf, SEARCH_MAX } from '@attendra/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useParams } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/feedback';
import { Input, Label } from '@/components/ui/input';
import { shownValue } from '@/components/patients/custom-fields';
import { Badge } from '@/components/ui/badge';
import { Highlight } from '@/components/ui/highlight';
import { api, BUSY, isBusy, useClinicConfig } from '@/lib/api';
import { age, dob, GENDER_LABEL, phone } from '@/lib/format';
import { usePets } from '@/lib/terms';

/** How long a search box waits after the last key before it searches: every search box uses it, through useSettled. */
export const SEARCH_SETTLE_MS = 150;

/** A short pause after each key, so a fast typist sends one request, not ten. Short enough to feel instant. */
export function useSettled<T>(value: T, ms = SEARCH_SETTLE_MS) {
  const [settled, setSettled] = useState(value);
  useEffect(() => { const t = setTimeout(() => setSettled(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return settled;
}

/** What a search box finds a record by, for its hint and its empty state. */
export function searchableBy(pets: boolean, exampleDob: string) {
  return pets
    ? `the pet's name, the owner's name (first, last, or both, in any order), a phone number in any form or its last four digits, a birthday like ${exampleDob}, or a request number like R-1042`
    : `a name (the patient's own or a parent's, in any order), a phone number in any form or its last four digits, a date of birth like ${exampleDob}, or a request number like R-1042`;
}

/**
 * Search as you type, from the first character: the start of a name ("m" finds every
 * Maria, "nguyen" every pet of the Nguyens), any digits of a phone number ("017"), a
 * whole date of birth, or a request number. What is typed goes in a POST body and
 * stays in this component: never in the address bar, never in a log.
 */
export function PatientSearch({ clinicId, onPick, renderResult, autoFocus, empty, status, exclude }: {
  clinicId: string;
  /** A record never offered: the one a merge keeps (note 52 C5), which cannot be merged into itself. */
  exclude?: string;
  onPick?: (p: PatientCard) => void;
  /** Render each result yourself, as a link for example; `query` is what was typed, for highlighting. */
  renderResult?: (p: PatientCard, query: string) => ReactNode;
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
  const hint = `Results show as you type: ${searchableBy(pets, copy.exampleDob)}.`;
  const query = useSettled(text.trim());
  const ready = query.length >= 1;
  const found = useQuery({
    queryKey: ['patient-search', clinicId, query, status ?? 'all'],
    queryFn: () => api<PatientList>(`/clinics/${clinicId}/patients/search`, { method: 'POST', body: JSON.stringify({ query, ...(status ? { status } : {}) }) }),
    enabled: ready,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
  });
  const results = { ...found, data: found.data && { ...found.data, patients: found.data.patients.filter((p) => p.id !== exclude) } };

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="patient-search">{pets ? 'Find a pet' : 'Find a patient'}</Label>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-muted" aria-hidden />
          <Input id="patient-search" type="search" maxLength={SEARCH_MAX} autoComplete="off" spellCheck={false} autoFocus={autoFocus} className="pl-9" value={text}
            onChange={(e) => setText(e.target.value)} placeholder={pets ? 'Pet or owner name, phone, or birthday' : 'Name, date of birth, or phone number'} />
        </div>
        <p className="text-xs text-text-muted">{hint}</p>
      </div>
      {!text.trim() ? empty : results.isPending ? <Skeleton className="h-24" /> : results.isError ? (
        <p className="text-sm text-danger">{isBusy(results.error) ? BUSY : 'The search did not work. Try again in a moment.'}</p>
      ) : !results.data?.patients.length ? (
        <p className="text-sm text-text-muted">{pets ? 'No pet matches. ' : 'No patient matches. '}Search by {searchableBy(pets, copy.exampleDob)}; or check the spelling, or add {pets ? 'it as a new pet' : 'them as a new patient'}.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border" aria-label={pets ? 'Matching pets' : 'Matching patients'} aria-busy={results.isFetching}>
          {results.data.patients.map((p) => (
            <li key={p.id}>
              {renderResult ? renderResult(p, query) : (
                <button type="button" onClick={() => onPick?.(p)} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:outline-none">
                  <PatientLine p={p} query={query} />
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

/** `query`: what was typed in a search, so the part of the name, the owner or the phone that matched is highlighted. */
export function PatientLine({ p, query = '' }: { p: PatientCard; query?: string }) {
  // always shown inside a clinic's pages: its age is counted on the clinic's date
  const { clinicId } = useParams<{ clinicId: string }>();
  const config = useClinicConfig(clinicId);
  // a name that only sounds like what was typed has nothing to light up; the digits of a phone always do
  const nameQuery = p.matchedOn === 'name' || !p.matchedOn ? query : '';
  const ownerQuery = p.matchedOn === 'owner' || !p.matchedOn ? query : '';
  return (
    <>
      <span className="min-w-0">
        <span className="flex items-center gap-2 truncate font-medium"><Highlight text={p.name} query={nameQuery} />{p.status === 'new' && <Badge tone="warn">New, check details</Badge>}</span>
        <span className="block text-xs text-text-muted">
          {p.species
            // a pet: what kind of animal, and whose
            ? <>{`${p.species.charAt(0).toUpperCase()}${p.species.slice(1)}${p.gender && p.gender !== 'undisclosed' ? `, ${(GENDER_LABEL[p.gender] ?? p.gender).toLowerCase()}` : ''}, born ${dob(p.dob)}, age ${age(p.dob, localDateOf(new Date(), config.data?.timezone ?? 'UTC'))}`}{p.guardianName ? <>, owner <Highlight text={p.guardianName} query={ownerQuery} /></> : ''}</>
            : <>{p.gender ? `${GENDER_LABEL[p.gender]}, born` : 'Born'} {dob(p.dob)}, age {age(p.dob, localDateOf(new Date(), config.data?.timezone ?? 'UTC'))}{p.guardianName ? <>, parent or guardian <Highlight text={p.guardianName} query={ownerQuery} /></> : ''}</>}
        </span>
        {/* the clinic's own fields it chose to show as columns (Settings, Fields and lists) */}
        {(() => {
          const shownFields = (config.data?.customFields ?? []).filter((f) => f.column && p.custom?.[f.id]);
          return shownFields.length ? <span className="block text-xs text-text-muted">{shownFields.map((f) => `${f.label}: ${shownValue(f, p.custom[f.id])}`).join(' · ')}</span> : null;
        })()}
      </span>
      {p.phone ? <span className="shrink-0 text-xs tabular-nums text-text-muted"><Highlight text={phone(p.phone)} query={query} /></span> : <Badge tone="danger">No phone</Badge>}
    </>
  );
}
