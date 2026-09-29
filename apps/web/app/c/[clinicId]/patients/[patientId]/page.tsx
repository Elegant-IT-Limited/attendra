// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { PatientProfile } from '@attendra/api/contracts';
import { localDateOf } from '@attendra/core';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Bot, CalendarPlus, Phone, User } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Outcome } from '@/components/calls/outcome';
import { PatientForm } from '@/components/patients/patient-form';
import { AppointmentPanel } from '@/components/schedule/appointment-panel';
import { BookingDialog, capital } from '@/components/schedule/booking-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, Empty, Skeleton } from '@/components/ui/feedback';
import { api, ApiFailure, useClinic, useClinicConfig } from '@/lib/api';
import { age, clinicTime, dayTitle, dob, duration, phone, TASK_TYPES, timeOf, zoneLabel } from '@/lib/format';
import { cn } from '@/lib/utils';

const TABS = [
  { id: 'appointments', label: 'Appointments' },
  { id: 'calls', label: 'Calls' },
  { id: 'requests', label: 'Requests' },
  { id: 'details', label: 'Details' },
] as const;
type Tab = (typeof TABS)[number]['id'];

export default function PatientPage() {
  const { clinicId, patientId } = useParams<{ clinicId: string; patientId: string }>();
  const { can } = useClinic(clinicId);
  const config = useClinicConfig(clinicId);
  const [tab, setTab] = useState<Tab>('appointments');
  const [open, setOpen] = useState<string | null>(null);
  const [booking, setBooking] = useState(false);
  const [saved, setSaved] = useState(false);
  const patient = useQuery({
    queryKey: ['patient', clinicId, patientId],
    queryFn: () => api<PatientProfile>(`/clinics/${clinicId}/patients/${patientId}`),
    enabled: can('patients:read'),
  });

  const back = (
    <Link href={`/c/${clinicId}/patients`} className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="size-4" /> Patients
    </Link>
  );
  const clinic = config.data;
  if (patient.isPending || !clinic) return <>{back}<Skeleton className="h-10 w-72" /><Skeleton className="mt-6 h-72" /></>;
  if (patient.isError || !patient.data) {
    const missing = patient.error instanceof ApiFailure && patient.error.status === 404;
    return <>{back}<Card><Empty title={missing ? 'Patient not found' : 'This record did not load'}>{missing ? 'They may belong to another clinic, or the link is wrong.' : 'Try again in a moment.'}</Empty></Card></>;
  }
  const p = patient.data;
  const tz = clinic.timezone;
  const provider = (id: string | null) => clinic.providers.find((x) => x.id === id)?.name ?? null;
  const visit = (id: string) => clinic.visitTypes.find((v) => v.id === id)?.name ?? id;
  const now = Date.now();
  const upcoming = p.appointments.filter((a) => a.status === 'booked' && Date.parse(a.startsAt) > now);
  const other = p.appointments.filter((a) => !upcoming.includes(a));
  const counts: Record<Tab, number | null> = { appointments: upcoming.length, calls: p.calls.length, requests: p.requests.filter((r) => r.status === 'open').length, details: null };

  return (
    <>
      {back}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{p.name}</h1>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <span>Age {age(p.dob)}, born {dob(p.dob)}</span>
            {p.phone && <a href={`tel:${p.phone}`} className="inline-flex items-center gap-1 hover:text-foreground"><Phone className="size-3.5" /> {phone(p.phone)}</a>}
            {provider(p.usualProviderId) && <span>Usually sees {provider(p.usualProviderId)}</span>}
          </p>
          <p className="text-xs text-muted-foreground">Times are {zoneLabel(tz)}. Opening this record is in the audit log.</p>
        </div>
        {can('schedule:write') && <Button onClick={() => setBooking(true)}><CalendarPlus /> Book</Button>}
      </div>

      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-border" role="tablist" aria-label="Patient record">
        {TABS.map((t) => (
          <button key={t.id} role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} onClick={() => setTab(t.id)}
            className={cn('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              tab === t.id ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
            {t.label}{counts[t.id] ? <span className="ml-1.5 rounded-full bg-muted px-1.5 text-xs">{counts[t.id]}</span> : null}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'appointments' && (
          <Card>
            {p.appointments.length === 0 ? (
              <Empty title="No appointments yet">Bookings made on the phone or at the desk appear here. Use Book to make one.</Empty>
            ) : (
              <ul className="divide-y divide-border">
                {[...upcoming, ...other].map((a, i) => {
                  const past = Date.parse(a.startsAt) <= now;
                  const Icon = a.bookedBy.kind === 'assistant' ? Bot : User;
                  return (
                    <li key={a.id} className={cn('flex flex-wrap items-center gap-3 px-5 py-3 text-sm', i === upcoming.length && upcoming.length > 0 && 'border-t-4 border-t-muted')}>
                      <div className="min-w-0 flex-1">
                        <p className={cn('font-medium', a.status === 'cancelled' && 'line-through opacity-60')}>
                          {dayTitle(localDateOf(new Date(a.startsAt), tz))} at {timeOf(a.startsAt, tz)}
                        </p>
                        <p className="text-muted-foreground">{capital(visit(a.visitTypeId))} with {provider(a.providerId)}</p>
                      </div>
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Icon className="size-3.5" aria-hidden />{a.bookedBy.kind === 'assistant' ? 'The assistant' : (a.bookedBy.name ?? 'Staff')}</span>
                      {a.status === 'cancelled' ? <Badge>Cancelled</Badge> : past ? <Badge>Past</Badge> : <Badge tone="ok">Upcoming</Badge>}
                      <Button size="sm" variant="outline" onClick={() => setOpen(a.id)}>{!past && a.status === 'booked' && can('schedule:write') ? 'Reschedule or cancel' : 'Open'}</Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        )}
        {tab === 'calls' && (
          <Card>
            {p.calls.length === 0 ? <Empty title="No verified calls">Calls appear here once the assistant has verified the caller as this patient by name and date of birth.</Empty> : (
              <ul className="divide-y divide-border">
                {p.calls.map((c) => (
                  <li key={c.id}>
                    <Link href={`/c/${clinicId}/calls/${c.id}`} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm hover:bg-muted">
                      <span className="flex-1 font-medium">{clinicTime(c.startedAt, tz)}</span>
                      <Outcome outcome={c.outcome} emergency={c.emergency} />
                      {c.channel === 'web' && <Badge tone="accent">Browser test</Badge>}
                      <span className="w-16 text-right tabular-nums text-muted-foreground">{duration(c.voiceSeconds)}</span>
                      <span className="text-primary">Transcript</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
        {tab === 'requests' && (
          <Card>
            {p.requests.length === 0 ? <Empty title="No requests">Refill and callback requests the assistant takes from this patient appear here.</Empty> : (
              <ul className="divide-y divide-border">
                {p.requests.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-start gap-3 px-5 py-3 text-sm">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{TASK_TYPES[r.type] ?? r.type}</p>
                      <p className="text-muted-foreground">{Object.entries(r.details).filter(([k]) => k !== 'callback_number').map(([, v]) => v).join(', ') || 'No details'}</p>
                      <p className="text-xs text-muted-foreground">{clinicTime(r.createdAt, tz)}</p>
                    </div>
                    <Badge tone={r.status === 'open' ? 'warn' : 'ok'}>{r.status === 'open' ? 'Open' : 'Done'}</Badge>
                    {r.callId && <Link href={`/c/${clinicId}/calls/${r.callId}`} className="text-primary hover:underline">The call</Link>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
        {tab === 'details' && (
          <Card>
            <CardContent className="py-5">
              {saved && <Alert className="mb-4">Saved. The assistant verifies them with these details from the next call on.</Alert>}
              {can('patients:write') ? (
                <PatientForm key={`${p.firstName}|${p.lastName}|${p.dob}|${p.phone}`} clinicId={clinicId} patientId={p.id} submitLabel="Save changes"
                  initial={{ firstName: p.firstName, lastName: p.lastName, dob: p.dob, phone: p.phone ?? '' }} onSaved={() => setSaved(true)} />
              ) : <p className="text-sm text-muted-foreground">You can read this record. The front desk or a manager can change it.</p>}
            </CardContent>
          </Card>
        )}
      </div>

      <AppointmentPanel clinicId={clinicId} clinic={clinic} appointmentId={open} onClose={() => setOpen(null)} canWrite={can('schedule:write')} />
      {can('schedule:write') && (
        <BookingDialog clinicId={clinicId} clinic={clinic} open={booking} onOpenChange={setBooking} patient={{ id: p.id, name: p.name }}
          findPatient={() => null} onBooked={() => { setTab('appointments'); }} />
      )}
    </>
  );
}
