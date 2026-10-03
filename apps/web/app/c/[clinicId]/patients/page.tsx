// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { PatientList } from '@attendra/api/contracts';
import { PATIENT_GUIDE, patientTemplate } from '@attendra/core';
import { useQuery } from '@tanstack/react-query';
import { FileUp, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { PatientForm } from '@/components/patients/patient-form';
import { PatientLine, PatientSearch } from '@/components/patients/patient-search';
import { ImportPanel } from '@/components/import-panel';
import { PageHeader } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Panel } from '@/components/ui/dialog';
import { Alert, Empty, Skeleton } from '@/components/ui/feedback';
import { api, useClinic } from '@/lib/api';

const row = 'flex w-full items-center justify-between gap-3 px-3 py-2.5 text-sm hover:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:outline-none';

export default function Patients() {
  const { clinicId } = useParams<{ clinicId: string }>();
  const router = useRouter();
  const { can, isPending } = useClinic(clinicId);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [onlyNew, setOnlyNew] = useState(false);
  const allowed = can('patients:read');
  // before anything is typed: the newest patients, or the ones the assistant added that nobody has checked
  const newest = useQuery({
    queryKey: ['patients', clinicId, onlyNew ? 'new' : 'all'],
    queryFn: () => api<PatientList>(`/clinics/${clinicId}/patients${onlyNew ? '?status=new' : ''}`),
    enabled: allowed,
  });
  const recent = useQuery({
    queryKey: ['patient', clinicId, 'recent'],
    queryFn: () => api<PatientList>(`/clinics/${clinicId}/patients/recent`),
    enabled: allowed,
  });

  if (isPending) return <><PageHeader title="Patients" /><Skeleton className="h-64" /></>;
  if (!allowed) {
    return (
      <>
        <PageHeader title="Patients" />
        <Card><Empty title="Patients are for the front desk">Your role can see calls and settings, not patient records. Ask a practice manager if you need more.</Empty></Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Patients" description="Find a patient by name, phone or date of birth as you type, and see their visits, calls and requests. The newest are at the top."
        actions={(
          <>
            {can('patients:import') && <Button variant="outline" onClick={() => setImporting(true)}><FileUp /> Import</Button>}
            {can('patients:write') && <Button onClick={() => setAdding(true)}><UserPlus /> Add patient</Button>}
          </>
        )} />
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardContent className="py-5">
            <div className="mb-3 flex gap-1" role="group" aria-label="Which patients">
              <Button size="sm" variant={onlyNew ? 'ghost' : 'outline'} aria-pressed={!onlyNew} onClick={() => setOnlyNew(false)}>All patients</Button>
              <Button size="sm" variant={onlyNew ? 'outline' : 'ghost'} aria-pressed={onlyNew} onClick={() => setOnlyNew(true)}>Added by the assistant, to check</Button>
            </div>
            <PatientSearch clinicId={clinicId} autoFocus status={onlyNew ? 'new' : undefined}
              renderResult={(p) => <Link href={`/c/${clinicId}/patients/${p.id}`} className={row}><PatientLine p={p} /></Link>}
              empty={newest.isPending ? <Skeleton className="h-40" /> : newest.isError ? <Alert tone="warn">This list did not load. Refresh to try again.</Alert>
                : !newest.data?.patients.length ? <Empty title={onlyNew ? 'Nothing to check' : 'No patients yet'}>{onlyNew ? 'Patients the assistant adds on a call appear here until someone checks their details.' : 'Add a patient, or import a list from a spreadsheet.'}</Empty>
                  : (
                    <div className="space-y-2">
                      <p className="text-xs text-text-muted">{onlyNew ? 'Added by the assistant, newest first. Open one to check and confirm their details.' : 'The newest patients first. Searches are recorded in the audit log by how many matched, never by what you typed.'}</p>
                      <ul className="divide-y divide-border rounded-md border border-border">
                        {newest.data.patients.map((p) => <li key={p.id}><Link href={`/c/${clinicId}/patients/${p.id}`} className={row}><PatientLine p={p} /></Link></li>)}
                      </ul>
                    </div>
                  )} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Opened recently</CardTitle></CardHeader>
          {recent.isPending ? <div className="space-y-2 p-4"><Skeleton className="h-8" /><Skeleton className="h-8" /></div>
            : recent.isError ? <Alert tone="warn" className="m-4">This list did not load. Refresh to try again.</Alert>
              : !recent.data?.patients.length ? <Empty title="Nobody yet">Patients you open appear here, so you can get back to them quickly.</Empty>
                : (
                  <ul className="divide-y divide-border">
                    {recent.data.patients.map((p) => <li key={p.id}><Link href={`/c/${clinicId}/patients/${p.id}`} className={row}><PatientLine p={p} /></Link></li>)}
                  </ul>
                )}
        </Card>
      </div>
      <ImportPanel open={importing} onOpenChange={setImporting} title="Import patients" what="patients" endpoint={`/clinics/${clinicId}/patients/import`}
        template={{ name: 'attendra-patients-template.csv', csv: patientTemplate() }} guide={PATIENT_GUIDE} />
      <Panel open={adding} onOpenChange={setAdding} title="Add patient" description="The assistant can verify them on their next call, by name, date of birth and phone.">
        <PatientForm clinicId={clinicId} submitLabel="Add patient" onCancel={() => setAdding(false)}
          onSaved={(id) => { setAdding(false); router.push(`/c/${clinicId}/patients/${id}`); }} />
      </Panel>
    </>
  );
}
