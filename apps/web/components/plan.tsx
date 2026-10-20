// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { ClinicPlan } from '@attendra/api/contracts';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api, useClinic } from '@/lib/api';
import { daysLeft } from '@/lib/format';
import { cn } from '@/lib/utils';

/** The hosting plan and the month's minutes; nothing on a self-hosted install. */
export function usePlan(clinicId: string) {
  return useQuery({ queryKey: ['plan', clinicId], queryFn: () => api<ClinicPlan>(`/clinics/${clinicId}/plan`), refetchInterval: 60_000, staleTime: 30_000 });
}

const dateOf = (iso: string, timeZone: string) => new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone });

/** A bar from empty to full: green, amber from 80%, red past the end. */
export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 100;
  return (
    <div className="h-2 overflow-hidden rounded-full bg-surface-sunken" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.min(value, max)}>
      <div className={cn('h-full rounded-full transition-[width]', value > max ? 'bg-danger' : pct >= 80 ? 'bg-warning' : 'bg-success')} style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * One line across every page for the owner: the trial's days, a payment that did not go
 * through. Everyone sees it when calls no longer reach the assistant.
 */
export function PlanBanner({ clinicId }: { clinicId: string }) {
  const { clinic } = useClinic(clinicId);
  const { data } = usePlan(clinicId);
  const plan = data?.plan;
  if (!plan || !clinic) return null;
  const owner = clinic.role === 'owner';
  const manage = owner && plan.manageUrl ? <a className="font-medium underline underline-offset-2" href={plan.manageUrl}>{plan.status === 'trial' ? 'Choose your plan' : 'Plan and billing'}</a> : null;
  let tone: 'info' | 'warn' | 'danger';
  let text: string;
  if (plan.status === 'trial' && plan.trialEndsAt && owner) {
    const left = daysLeft(plan.trialEndsAt, Date.now());
    tone = left <= 3 ? 'warn' : 'info';
    text = left > 0 ? `Free trial: ${left} ${left === 1 ? 'day' : 'days'} left, until ${dateOf(plan.trialEndsAt, clinic.timezone)}.` : 'Your free trial has ended. Choose your plan to take real calls.';
  } else if (plan.status === 'past_due' && owner) {
    tone = 'warn';
    text = 'Your last payment did not go through. Update your card to keep your number connected.';
  } else if (plan.status === 'suspended') {
    tone = 'danger';
    text = owner ? 'Calls no longer reach your assistant: the payment is missing.' : 'Calls no longer reach the assistant. The clinic owner can fix this.';
  } else return null;
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cn('border-b px-6 py-2 text-sm', tone === 'info' && 'border-border bg-info-soft', tone === 'warn' && 'border-warning/30 bg-warning-soft', tone === 'danger' && 'border-danger/30 bg-danger-soft')}>
      {text} {manage}
    </div>
  );
}

/** The month's phone minutes against the plan's, for every member. */
export function PlanMeter({ clinicId }: { clinicId: string }) {
  const { clinic } = useClinic(clinicId);
  const { data } = usePlan(clinicId);
  const plan = data?.plan;
  if (!plan || !clinic) return null;
  if (plan.status === 'trial') {
    if (!plan.trialEndsAt) return null;
    const left = daysLeft(plan.trialEndsAt, Date.now());
    const total = plan.trialDays;
    return (
      <Card>
        <CardHeader><CardTitle>Free trial</CardTitle></CardHeader>
        <CardContent className="space-y-2 pt-2">
          <p className="text-sm"><span className="text-xl font-semibold tabular-nums">{left}</span> {left === 1 ? 'day' : 'days'} left</p>
          <Meter value={Math.max(0, total - left)} max={total} label="Trial days used" />
          <p className="text-xs text-text-muted">{left > 0 ? `Ends ${dateOf(plan.trialEndsAt, clinic.timezone)}.` : 'The trial has ended.'}</p>
        </CardContent>
      </Card>
    );
  }
  if (plan.status === 'canceled' || data.minutesUsed === null) return null;
  const used = data.minutesUsed;
  const over = used - plan.includedMinutes;
  return (
    <Card>
      <CardHeader><CardTitle>Call minutes this month</CardTitle></CardHeader>
      <CardContent className="space-y-2 pt-2">
        <p className="text-sm"><span className="text-xl font-semibold tabular-nums">{used}</span> <span className="text-text-muted">of {plan.includedMinutes} included</span></p>
        <Meter value={used} max={plan.includedMinutes} label="Call minutes used this month" />
        <p className="text-xs text-text-muted">
          {over > 0 ? `${over} minutes over the plan; they are billed per minute. ` : `${plan.includedMinutes - used} minutes left. `}
          {plan.periodEnd ? `The count starts again on ${dateOf(plan.periodEnd, clinic.timezone)}.` : ''}
        </p>
        {clinic.role === 'owner' && plan.manageUrl && <a className="text-sm font-medium text-primary underline-offset-2 hover:underline" href={plan.manageUrl}>Plan and billing</a>}
      </CardContent>
    </Card>
  );
}
