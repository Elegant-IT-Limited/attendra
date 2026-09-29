// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { PatientList } from '@attendra/api/contracts';
import { useQuery } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
import { useState } from 'react';
import { PatientForm } from '@/components/patients/patient-form';
import { PatientLine, PatientSearch } from '@/components/patients/patient-search';
import type { PatientChoice } from '@/components/schedule/booking-dialog';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';

/** The first step of a booking: find the patient, pick someone opened recently, or add them there and then. */
export function PatientPicker({ clinicId, onPick, canAdd }: { clinicId: string; onPick: (p: PatientChoice) => void; canAdd: boolean }) {
  const [adding, setAdding] = useState(false);
  const recent = useQuery({ queryKey: ['patient', clinicId, 'recent'], queryFn: () => api<PatientList>(`/clinics/${clinicId}/patients/recent`) });
  const pick = (p: { id: string; name: string }) => onPick({ id: p.id, name: p.name });

  if (adding) {
    return (
      <div className="space-y-3">
        <p className="text-sm font-medium">New patient</p>
        <PatientForm clinicId={clinicId} submitLabel="Add and continue" onCancel={() => setAdding(false)}
          onSaved={(id, input) => pick({ id, name: `${input.firstName} ${input.lastName}` })} />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <PatientSearch clinicId={clinicId} autoFocus onPick={pick}
        empty={recent.data?.patients.length ? (
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-text-muted">Opened recently</p>
            <ul className="divide-y divide-border rounded-md border border-border">
              {recent.data.patients.map((p) => (
                <li key={p.id}>
                  <button type="button" onClick={() => pick(p)} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:outline-none">
                    <PatientLine p={p} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null} />
      {canAdd && <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}><UserPlus /> Add a new patient</Button>}
    </div>
  );
}
