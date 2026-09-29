// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { PatientList } from '@attendra/api/contracts';
import { useQuery } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { PatientForm } from '@/components/patients/patient-form';
import { PatientLine, PatientSearch } from '@/components/patients/patient-search';
import { PageHeader } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Panel } from '@/components/ui/dialog';
import { Alert, Empty, Skeleton } from '@/components/ui/feedback';
import { api, useClinic } from '@/lib/api';

const row = 'flex w-full items-center justify-between gap-3 px-3 py-2.5 text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none';

export default function Patients() {
  const { clinicId } = useParams<{ clinicId: string }>();
  const router = useRouter();
  const { can, isPending } = useClinic(clinicId);
  const [adding, setAdding] = useState(false);
  const allowed = can('patients:read');
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
      <PageHeader title="Patients" description="Find a patient by name, date of birth or phone, and see their visits, calls and requests."
        actions={can('patients:write') && <Button onClick={() => setAdding(true)}><UserPlus /> Add patient</Button>} />
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardContent className="py-5">
            <PatientSearch clinicId={clinicId} autoFocus
              renderResult={(p) => <Link href={`/c/${clinicId}/patients/${p.id}`} className={row}><PatientLine p={p} /></Link>}
              empty={<p className="text-sm text-muted-foreground">Results appear as you type. Searches are recorded in the audit log by how many patients matched, never by what you typed.</p>} />
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
      <Panel open={adding} onOpenChange={setAdding} title="Add patient" description="The assistant can verify them on their next call, by name and date of birth.">
        <PatientForm clinicId={clinicId} submitLabel="Add patient" onCancel={() => setAdding(false)}
          onSaved={(id) => { setAdding(false); router.push(`/c/${clinicId}/patients/${id}`); }} />
      </Panel>
    </>
  );
}
