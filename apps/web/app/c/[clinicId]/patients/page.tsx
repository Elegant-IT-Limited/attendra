// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { PatientList } from '@attendra/api/contracts';
import { managedList, PATIENT_GUIDE, PET_GUIDE, patientTemplate, petTemplate } from '@attendra/core';
import { useQuery } from '@tanstack/react-query';
import { FileUp, SlidersHorizontal, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { PatientForm } from '@/components/patients/patient-form';
import { PatientLine, PatientSearch } from '@/components/patients/patient-search';
import { ImportPanel } from '@/components/import-panel';
import { PageHeader } from '@/components/shell';
import { Button, buttonStyles } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Panel } from '@/components/ui/dialog';
import { Alert, Empty, Skeleton } from '@/components/ui/feedback';
import { api, useClinic, useClinicConfig } from '@/lib/api';
import { Label, Select } from '@/components/ui/input';
import { useTerms } from '@/lib/terms';

const row = 'flex w-full items-center justify-between gap-3 px-3 py-2.5 text-sm hover:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:outline-none';

export default function Patients() {
  const { clinicId } = useParams<{ clinicId: string }>();
  const terms = useTerms(clinicId);
  const pet = terms.patient === 'pet';
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
  // by kind of animal, or by one of the clinic's own dropdown or yes-or-no fields: read on the server, newest first
  const config = useClinicConfig(clinicId);
  const [species, setSpecies] = useState('');
  const [fieldFilter, setFieldFilter] = useState<{ id: string; value: string }>({ id: '', value: '' });
  const filterable = (config.data?.customFields ?? []).filter((f) => f.kind === 'choice' || f.kind === 'multi' || f.kind === 'yesno');
  const filterField = filterable.find((f) => f.id === fieldFilter.id);
  const speciesList = config.data ? managedList(config.data, 'species') : [];
  const filtering = !!species || (!!filterField && !!fieldFilter.value);
  const byFilter = useQuery({
    queryKey: ['patients', clinicId, 'filter', species, fieldFilter.id, fieldFilter.value],
    queryFn: () => api<PatientList>(`/clinics/${clinicId}/patients/filter`, { method: 'POST', body: JSON.stringify({ ...(species ? { species } : {}), ...(filterField && fieldFilter.value ? { field: fieldFilter } : {}) }) }),
    enabled: allowed && filtering,
  });
  const recent = useQuery({
    queryKey: ['patient', clinicId, 'recent'],
    queryFn: () => api<PatientList>(`/clinics/${clinicId}/patients/recent`),
    enabled: allowed,
  });

  if (isPending) return <><PageHeader title={terms.title('patients')} /><Skeleton className="h-64" /></>;
  if (!allowed) {
    return (
      <>
        <PageHeader title={terms.title('patients')} />
        <Card><Empty title={`${terms.title('patients')} are for the front desk`}>Your role can see calls and settings, not {terms.patient} records. Ask a practice manager if you need more.</Empty></Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title={terms.title('patients')} description={pet ? 'Find a pet by its name, its owner\'s name, a phone number or a birthday as you type, and see its visits, calls and requests. The newest are at the top.' : 'Find a patient by name, phone or date of birth as you type, and see their visits, calls and requests. The newest are at the top.'}
        actions={(
          <>
            {can('settings:write') && <Link href={`/c/${clinicId}/settings/fields?tab=patients`} className={buttonStyles({ variant: 'ghost' })}><SlidersHorizontal /> Manage fields</Link>}
            {can('patients:import') && <Button variant="outline" onClick={() => setImporting(true)}><FileUp /> Import</Button>}
            {can('patients:write') && <Button onClick={() => setAdding(true)}><UserPlus /> Add {terms.patient}</Button>}
          </>
        )} />
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardContent className="py-5">
            {/* one filter row, the same as on the other lists: which patients, then the dropdowns */}
            <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Filter the list">
            <div className="flex gap-1" role="group" aria-label="Which patients">
              <Button size="sm" variant={onlyNew ? 'ghost' : 'outline'} aria-pressed={!onlyNew} onClick={() => setOnlyNew(false)}>All {terms.patients}</Button>
              <Button size="sm" variant={onlyNew ? 'outline' : 'ghost'} aria-pressed={onlyNew} onClick={() => setOnlyNew(true)}>Added by the assistant, to check</Button>
            </div>
            {(pet && speciesList.length > 0) || filterable.length > 0 ? (
              <>
                {pet && speciesList.length > 0 && (
                  <>
                    <Label htmlFor="pet-species" className="sr-only">Kind of animal</Label>
                    <Select id="pet-species" className="h-8 w-40" value={species} onChange={(e) => setSpecies(e.target.value)}>
                      <option value="">Any kind</option>
                      {speciesList.map((s) => <option key={s} value={s}>{s}</option>)}
                    </Select>
                  </>
                )}
                {filterable.length > 0 && (
                  <>
                    <Label htmlFor="patient-field" className="sr-only">Field</Label>
                    <Select id="patient-field" className="h-8 w-44" value={fieldFilter.id} onChange={(e) => setFieldFilter({ id: e.target.value, value: '' })}>
                      <option value="">Any field</option>
                      {filterable.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                    </Select>
                    {filterField && (
                      <>
                        <Label htmlFor="patient-field-value" className="sr-only">Value</Label>
                        <Select id="patient-field-value" className="h-8 w-40" value={fieldFilter.value} onChange={(e) => setFieldFilter({ ...fieldFilter, value: e.target.value })}>
                          <option value="">Any value</option>
                          {(filterField.kind === 'yesno' ? ['yes', 'no'] : filterField.options ?? []).map((o) => <option key={o} value={o}>{filterField.kind === 'yesno' ? (o === 'yes' ? 'Yes' : 'No') : o}</option>)}
                        </Select>
                      </>
                    )}
                  </>
                )}
                {filtering && <Button size="sm" variant="ghost" onClick={() => { setSpecies(''); setFieldFilter({ id: '', value: '' }); }}>Clear</Button>}
              </>
            ) : null}
            </div>
            {filtering ? (
              byFilter.isPending ? <Skeleton className="h-40" /> : byFilter.isError ? <Alert tone="warn">This list did not load. Refresh to try again.</Alert>
                : !byFilter.data?.patients.length ? <Empty title="Nobody matches">Try another kind or value, or clear the filter.</Empty>
                  : (
                    <div className="space-y-2">
                      <p className="text-xs text-text-muted">{byFilter.data.truncated ? 'The newest matches first, up to 100. Narrow the filter to see others.' : 'Every match, newest first.'}</p>
                      <ul className="divide-y divide-border rounded-md border border-border">
                        {byFilter.data.patients.map((p) => <li key={p.id}><Link href={`/c/${clinicId}/patients/${p.id}`} className={row}><PatientLine p={p} /></Link></li>)}
                      </ul>
                    </div>
                  )
            ) : (
            <PatientSearch clinicId={clinicId} autoFocus status={onlyNew ? 'new' : undefined}
              renderResult={(p) => <Link href={`/c/${clinicId}/patients/${p.id}`} className={row}><PatientLine p={p} /></Link>}
              empty={newest.isPending ? <Skeleton className="h-40" /> : newest.isError ? <Alert tone="warn">This list did not load. Refresh to try again.</Alert>
                : !newest.data?.patients.length ? <Empty title={onlyNew ? 'Nothing to check' : `No ${terms.patients} yet`}>{onlyNew ? `${terms.title('patients')} the assistant adds on a call appear here until someone checks their details.` : `Add a ${terms.patient}, or import a list from a spreadsheet.`}</Empty>
                  : (
                    <div className="space-y-2">
                      <p className="text-xs text-text-muted">{onlyNew ? 'Added by the assistant, newest first. Open one to check and confirm their details.' : `The newest ${terms.patients} first. Searches are recorded in the audit log by how many matched, never by what you typed.`}</p>
                      <ul className="divide-y divide-border rounded-md border border-border">
                        {newest.data.patients.map((p) => <li key={p.id}><Link href={`/c/${clinicId}/patients/${p.id}`} className={row}><PatientLine p={p} /></Link></li>)}
                      </ul>
                    </div>
                  )} />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Opened recently</CardTitle></CardHeader>
          {recent.isPending ? <div className="space-y-2 p-4"><Skeleton className="h-8" /><Skeleton className="h-8" /></div>
            : recent.isError ? <Alert tone="warn" className="m-4">This list did not load. Refresh to try again.</Alert>
              : !recent.data?.patients.length ? <Empty title="None yet">{pet ? 'Pets' : 'Patients'} you open appear here, so you can get back to them quickly.</Empty>
                : (
                  <ul className="divide-y divide-border">
                    {recent.data.patients.map((p) => <li key={p.id}><Link href={`/c/${clinicId}/patients/${p.id}`} className={row}><PatientLine p={p} /></Link></li>)}
                  </ul>
                )}
        </Card>
      </div>
      <ImportPanel open={importing} onOpenChange={setImporting} title={`Import ${terms.patients}`} what={terms.patients} endpoint={`/clinics/${clinicId}/patients/import`}
        template={pet ? { name: 'attendra-pets-template.csv', csv: petTemplate() } : { name: 'attendra-patients-template.csv', csv: patientTemplate() }} guide={pet ? PET_GUIDE : PATIENT_GUIDE} />
      <Panel open={adding} onOpenChange={setAdding} title={`Add ${terms.patient}`} description={pet ? 'The assistant can find them on the owner\'s next call, by the owner\'s name, the pet\'s name and the phone.' : 'The assistant can verify them on their next call, by name, date of birth and phone.'}>
        <PatientForm clinicId={clinicId} submitLabel={`Add ${terms.patient}`} onCancel={() => setAdding(false)}
          onSaved={(id) => { setAdding(false); router.push(`/c/${clinicId}/patients/${id}`); }} />
      </Panel>
    </>
  );
}
