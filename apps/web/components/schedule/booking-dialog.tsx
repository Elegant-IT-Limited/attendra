// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { AppointmentChange } from '@attendra/api/contracts';
import { type ClinicConfig, localDateOf } from '@attendra/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { type PickedSlot, SlotPicker } from '@/components/schedule/slot-picker';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/dialog';
import { Alert } from '@/components/ui/feedback';
import { Label, Select, Textarea } from '@/components/ui/input';
import { api, ApiFailure, newKey } from '@/lib/api';
import { dayTitle, timeOf } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface PatientChoice { id: string; name: string; detail?: string }

const STEPS = ['Patient', 'Time', 'Note', 'Confirm'] as const;

/**
 * Books an appointment in four steps: who, when (from real open times), an optional
 * note, and a confirmation that reads the booking back. `findPatient` renders the
 * first step, so the patient search can live where patients do.
 */
export function BookingDialog({ clinicId, clinic, open, onOpenChange, patient: fixed, findPatient, onBooked }: {
  clinicId: string;
  clinic: ClinicConfig;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Book for this patient and skip the first step. */
  patient?: PatientChoice | null;
  findPatient: (pick: (p: PatientChoice) => void) => ReactNode;
  onBooked?: (appointmentId: string, startsAt: string) => void;
}) {
  const queries = useQueryClient();
  const today = localDateOf(new Date(), clinic.timezone);
  const [step, setStep] = useState(0);
  const [patient, setPatient] = useState<PatientChoice | null>(null);
  const [visitTypeId, setVisitTypeId] = useState(clinic.visitTypes[0]?.id ?? '');
  const [providerId, setProviderId] = useState<string | null>(null);
  const [from, setFrom] = useState(today);
  const [slot, setSlot] = useState<PickedSlot | null>(null);
  const [note, setNote] = useState('');
  const [key, setKey] = useState(newKey);
  const [error, setError] = useState<string | null>(null);

  // every time the dialog opens it starts over, with a new idempotency key
  useEffect(() => {
    if (!open) return;
    setPatient(fixed ?? null); setStep(fixed ? 1 : 0); setSlot(null); setNote(''); setError(null); setFrom(today); setKey(newKey());
  }, [open, fixed?.id, today]);

  const providers = clinic.providers.filter((p) => p.visitTypeIds.includes(visitTypeId));
  const book = useMutation({
    mutationFn: () => api<AppointmentChange>(`/clinics/${clinicId}/appointments`, {
      method: 'POST',
      body: JSON.stringify({ patientId: patient!.id, providerId: slot!.providerId, visitTypeId, startsAt: slot!.startsAt, note: note.trim() || undefined, idempotencyKey: key }),
    }),
    onMutate: () => setError(null),
    onSuccess: (r) => {
      void queries.invalidateQueries({ queryKey: ['schedule', clinicId] });
      void queries.invalidateQueries({ queryKey: ['patient', clinicId] });
      onOpenChange(false);
      onBooked?.(r.appointmentId, slot!.startsAt);
    },
    onError: (e) => {
      if (e instanceof ApiFailure && e.status === 409) {
        // the time went while they were deciding: back to the times, with fresh ones
        setError(e.body.message ?? 'That time was just taken. Pick another one.');
        setSlot(null); setStep(1); setKey(newKey());
        void queries.invalidateQueries({ queryKey: ['slots', clinicId] });
      } else if (e instanceof ApiFailure) {
        // the server answered and refused it: say why, not that the network failed
        setError(`The booking was not saved: ${e.body.issues?.[0]?.message ?? e.body.message ?? 'it was refused'}.`);
      } else setError('The booking was not saved. Check your connection and try again.');
    },
  });

  const provider = clinic.providers.find((p) => p.id === slot?.providerId);
  const visit = clinic.visitTypes.find((v) => v.id === visitTypeId);
  const canNext = [!!patient, !!slot, true, true][step];

  return (
    <Panel open={open} onOpenChange={onOpenChange} title="New booking" className="max-w-2xl"
      description={<Stepper step={step} />}
      footer={<>
        {step > (fixed ? 1 : 0) && <Button variant="ghost" onClick={() => setStep(step - 1)} disabled={book.isPending}>Back</Button>}
        {step < 3
          ? <Button onClick={() => setStep(step + 1)} disabled={!canNext}>Next</Button>
          : <Button onClick={() => book.mutate()} disabled={book.isPending}>{book.isPending ? 'Booking…' : 'Book appointment'}</Button>}
      </>}>
      {error && <Alert tone="warn" className="mb-4">{error}</Alert>}
      {step === 0 && findPatient((p) => { setPatient(p); setStep(1); })}
      {step === 1 && (
        <div className="space-y-4">
          {patient && <p className="text-sm">For <span className="font-medium">{patient.name}</span></p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="visit-type">Visit type</Label>
              <Select id="visit-type" value={visitTypeId} onChange={(e) => { setVisitTypeId(e.target.value); setSlot(null); setProviderId(null); }}>
                {clinic.visitTypes.map((v) => <option key={v.id} value={v.id}>{capital(v.name)} ({v.minutes} min)</option>)}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="provider">Provider</Label>
              <Select id="provider" value={providerId ?? ''} onChange={(e) => { setProviderId(e.target.value || null); setSlot(null); }}>
                <option value="">Any provider</option>
                {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </div>
          </div>
          <SlotPicker clinicId={clinicId} clinic={clinic} visitTypeId={visitTypeId} providerId={providerId} from={from} onFrom={setFrom} value={slot} onChange={setSlot} />
        </div>
      )}
      {step === 2 && (
        <div className="space-y-1.5">
          <Label htmlFor="note">Note for the team (optional)</Label>
          <Textarea id="note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Anything the provider or front desk should know" />
          <p className="text-xs text-text-muted">Only staff see this note. It is stored encrypted.</p>
        </div>
      )}
      {step === 3 && slot && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-text-muted">Patient</dt><dd className="font-medium">{patient?.name}</dd>
          <dt className="text-text-muted">When</dt><dd className="font-medium">{dayTitle(localDateOf(new Date(slot.startsAt), clinic.timezone))} at {timeOf(slot.startsAt, clinic.timezone)}</dd>
          <dt className="text-text-muted">With</dt><dd>{provider?.name}</dd>
          <dt className="text-text-muted">Visit</dt><dd>{capital(visit?.name ?? '')}, {visit?.minutes} minutes</dd>
          {note.trim() && <><dt className="text-text-muted">Note</dt><dd className="whitespace-pre-wrap">{note.trim()}</dd></>}
        </dl>
      )}
    </Panel>
  );
}

function Stepper({ step }: { step: number }) {
  return (
    <span className="mt-1 flex flex-wrap items-center gap-2 text-xs">
      {STEPS.map((s, i) => (
        <span key={s} className={cn('inline-flex items-center gap-1', i === step ? 'font-medium text-text' : 'text-text-muted')} aria-current={i === step ? 'step' : undefined}>
          <span className={cn('flex size-4 items-center justify-center rounded-full text-xs', i < step ? 'bg-primary text-on-primary' : i === step ? 'border border-primary' : 'border border-border')}>
            {i < step ? <Check className="size-2.5" /> : i + 1}
          </span>
          {s}
        </span>
      ))}
    </span>
  );
}

export const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
