// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { AppointmentChange, AppointmentDetail, BookedBy } from '@attendra/api/contracts';
import { type ClinicConfig, localDateOf } from '@attendra/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, CalendarClock, Phone, User, XCircle } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useState } from 'react';
import { capital } from '@/components/schedule/booking-dialog';
import { type PickedSlot, SlotPicker } from '@/components/schedule/slot-picker';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/dialog';
import { Alert, Skeleton } from '@/components/ui/feedback';
import { Label, Select } from '@/components/ui/input';
import { api, ApiFailure } from '@/lib/api';
import { CANCEL_REASONS, clinicTime, dayTitle, dob, phone, timeOf } from '@/lib/format';

type Mode = 'view' | 'reschedule' | 'cancel';

export const LINK_BUTTON = 'inline-flex h-9 items-center justify-center gap-2 rounded-md border border-input bg-card px-4 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** One appointment, opened from the schedule. Closes with Escape; every change says how it went. */
export function AppointmentPanel({ clinicId, clinic, appointmentId, onClose, canWrite, patientHref }: {
  clinicId: string;
  clinic: ClinicConfig;
  appointmentId: string | null;
  onClose: () => void;
  canWrite: boolean;
  /** Where the patient's profile lives, once there is one. */
  patientHref?: (patientId: string) => string;
}) {
  const queries = useQueryClient();
  const [mode, setMode] = useState<Mode>('view');
  const [slot, setSlot] = useState<PickedSlot | null>(null);
  const [from, setFrom] = useState(() => localDateOf(new Date(), clinic.timezone));
  const [reason, setReason] = useState('patient_asked');
  const [message, setMessage] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);
  const tz = clinic.timezone;

  const detail = useQuery({
    queryKey: ['appointment', clinicId, appointmentId],
    queryFn: () => api<AppointmentDetail>(`/clinics/${clinicId}/appointments/${appointmentId}`),
    enabled: !!appointmentId,
  });
  const change = useMutation({
    mutationFn: (req: { path: 'reschedule' | 'cancel'; body: object }) => api<AppointmentChange>(`/clinics/${clinicId}/appointments/${appointmentId}/${req.path}`, { method: 'POST', body: JSON.stringify(req.body) }),
    onMutate: () => setMessage(null),
    onSuccess: (_r, req) => {
      setMessage({ tone: 'info', text: req.path === 'cancel' ? 'Cancelled. The time is free again.' : 'Moved. The schedule shows the new time.' });
      setMode('view'); setSlot(null);
      void queries.invalidateQueries({ queryKey: ['schedule', clinicId] });
      void queries.invalidateQueries({ queryKey: ['appointment', clinicId, appointmentId] });
      void queries.invalidateQueries({ queryKey: ['patient', clinicId] });
      void queries.invalidateQueries({ queryKey: ['slots', clinicId] });
    },
    onError: (e) => {
      setMessage({ tone: 'warn', text: e instanceof ApiFailure && e.body.message ? e.body.message : 'That did not save. Try again.' });
      if (e instanceof ApiFailure && e.status === 409) { setSlot(null); void queries.invalidateQueries({ queryKey: ['slots', clinicId] }); }
    },
  });

  const close = (open: boolean) => { if (!open) { setMode('view'); setMessage(null); setSlot(null); onClose(); } };
  const a = detail.data;
  const provider = (id: string) => clinic.providers.find((p) => p.id === id)?.name ?? id;
  const visit = (id: string) => clinic.visitTypes.find((v) => v.id === id);
  const upcoming = a && a.status === 'booked' && new Date(a.startsAt) > new Date();

  let footer: ReactNode = a && patientHref ? <Link href={patientHref(a.patient.id)} className={LINK_BUTTON}>Open patient</Link> : null;
  if (a && canWrite && upcoming) {
    footer = mode === 'view' ? (
      <>
        {patientHref && <Link href={patientHref(a.patient.id)} className={LINK_BUTTON}>Open patient</Link>}
        <Button variant="outline" onClick={() => { setMode('cancel'); setMessage(null); }}><XCircle /> Cancel</Button>
        <Button onClick={() => { setMode('reschedule'); setMessage(null); setFrom(localDateOf(new Date(), tz)); }}><CalendarClock /> Reschedule</Button>
      </>
    ) : mode === 'cancel' ? (
      <>
        <Button variant="ghost" onClick={() => setMode('view')} disabled={change.isPending}>Keep it</Button>
        <Button variant="danger" disabled={change.isPending} onClick={() => change.mutate({ path: 'cancel', body: { reason } })}>{change.isPending ? 'Cancelling…' : 'Cancel appointment'}</Button>
      </>
    ) : (
      <>
        <Button variant="ghost" onClick={() => setMode('view')} disabled={change.isPending}>Back</Button>
        <Button disabled={!slot || change.isPending} onClick={() => change.mutate({ path: 'reschedule', body: { startsAt: slot!.startsAt, providerId: slot!.providerId } })}>
          {change.isPending ? 'Moving…' : 'Move appointment'}
        </Button>
      </>
    );
  }

  return (
    <Panel side="right" open={!!appointmentId} onOpenChange={close} title={a ? a.patientName : 'Appointment'}
      description={a ? `${dayTitle(localDateOf(new Date(a.startsAt), tz))}, ${timeOf(a.startsAt, tz)} to ${timeOf(a.endsAt, tz)}` : undefined} footer={footer}>
      {detail.isPending ? <div className="space-y-3"><Skeleton className="h-6 w-48" /><Skeleton className="h-32" /></div>
        : detail.isError || !a ? (
          <Alert tone="warn">{detail.error instanceof ApiFailure && detail.error.status === 404 ? 'This appointment is not on this clinic\'s schedule.' : 'The appointment did not load. Close this and try again.'}</Alert>
        ) : (
          <div className="space-y-5">
            {message && <Alert tone={message.tone}>{message.text}</Alert>}
            {a.status === 'cancelled' && (
              <Alert tone="warn" title="Cancelled">
                {a.cancelReason ? CANCEL_REASONS[a.cancelReason] : 'No reason given'}{a.cancelledBy ? `, by ${who(a.cancelledBy)}` : ''}.
              </Alert>
            )}
            {mode === 'reschedule' ? (
              <div className="space-y-3">
                <p className="text-sm">Pick a new time. The visit stays a {visit(a.visitTypeId)?.name}.</p>
                <SlotPicker clinicId={clinicId} clinic={clinic} visitTypeId={a.visitTypeId} providerId={null} from={from} onFrom={setFrom} value={slot} onChange={setSlot} excluding={a.id} />
              </div>
            ) : mode === 'cancel' ? (
              <div className="space-y-1.5">
                <Label htmlFor="cancel-reason">Why is it cancelled?</Label>
                <Select id="cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
                  {Object.entries(CANCEL_REASONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
                <p className="text-xs text-muted-foreground">The time opens up for booking again straight away.</p>
              </div>
            ) : (
              <>
                <section className="space-y-2">
                  <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Patient</h3>
                  <div className="text-sm">
                    {patientHref ? <Link href={patientHref(a.patient.id)} className="font-medium hover:underline">{a.patient.name}</Link> : <p className="font-medium">{a.patient.name}</p>}
                    <p className="text-muted-foreground">Born {dob(a.patient.dob)}</p>
                    {a.patient.phone && <a href={`tel:${a.patient.phone}`} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"><Phone className="size-3.5" /> {phone(a.patient.phone)}</a>}
                  </div>
                </section>
                <section className="space-y-2">
                  <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Visit</h3>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                    <dt className="text-muted-foreground">With</dt><dd>{provider(a.providerId)}</dd>
                    <dt className="text-muted-foreground">Type</dt><dd>{capital(visit(a.visitTypeId)?.name ?? a.visitTypeId)}, {visit(a.visitTypeId)?.minutes} minutes</dd>
                    <dt className="text-muted-foreground">Note</dt><dd className="whitespace-pre-wrap">{a.note ?? <span className="text-muted-foreground">None</span>}</dd>
                  </dl>
                </section>
                <section className="space-y-2">
                  <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Booked</h3>
                  <p className="flex items-start gap-2 text-sm">
                    {a.bookedBy.kind === 'assistant' ? <Bot className="mt-0.5 size-4 text-primary" /> : <User className="mt-0.5 size-4 text-muted-foreground" />}
                    <span>By {who(a.bookedBy)}, {clinicTime(a.createdAt, tz)}.{' '}
                      {a.bookedBy.kind === 'assistant' && <Link href={`/c/${clinicId}/calls/${a.bookedBy.callId}`} className="text-primary hover:underline">Open the call and its transcript</Link>}
                    </span>
                  </p>
                </section>
                {!upcoming && a.status === 'booked' && <p className="text-xs text-muted-foreground">This appointment has started or passed, so it can no longer be moved or cancelled.</p>}
              </>
            )}
          </div>
        )}
    </Panel>
  );
}

export function who(b: BookedBy) {
  return b.kind === 'assistant' ? 'the assistant, on a call' : (b.name ?? 'a former staff member');
}
