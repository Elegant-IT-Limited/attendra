// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { Quality, QualityWeek } from '@attendra/api/contracts';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/shell';
import { Sparkline } from '@/components/ui/bits';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, Empty, Skeleton } from '@/components/ui/feedback';
import { Table, TD, TH, THead, TRow } from '@/components/ui/table';
import { api, useClinic } from '@/lib/api';
import { dayTitle, REFUSALS, usd } from '@/lib/format';

const pct = (n: number | null) => (n === null ? 'no calls' : `${Math.round(n * 100)}%`);
const money = (n: number | null) => (n === null ? 'none' : usd(n));
// "29 Sep", day first like every other date in the dashboard
const short = (d: string) => dayTitle(d, 'short').replace(/^\w+ /, '');

type Metric = { key: string; label: string; explain: string; value: (w: QualityWeek) => string; trend: (w: QualityWeek) => number | null; href: (w: QualityWeek) => string };

/**
 * How well the assistant is doing, week by week, from database counts. Every number
 * opens the calls behind it. No patient data: outcomes, codes, counts and times.
 */
export default function QualityPage() {
  const { clinicId } = useParams<{ clinicId: string }>();
  const { can, isPending } = useClinic(clinicId);
  const allowed = can('quality:read');
  const q = useQuery({ queryKey: ['quality', clinicId], queryFn: () => api<Quality>(`/clinics/${clinicId}/quality?weeks=8`), enabled: allowed, refetchInterval: 60_000 });
  const calls = (params: Record<string, string>) => `/c/${clinicId}/calls?${new URLSearchParams(params)}`;
  const week = (w: QualityWeek, extra: Record<string, string> = {}) => calls({ from: w.start, to: w.end, ...extra });

  const METRICS: Metric[] = [
    { key: 'containment', label: 'Handled without staff', explain: 'Calls the assistant finished itself: booked, moved, cancelled or answered.', value: (w) => pct(w.containmentRate), trend: (w) => w.containmentRate, href: (w) => week(w) },
    { key: 'booking', label: 'Booking success', explain: 'Bookings made, out of calls where the assistant proposed a time.', value: (w) => (w.bookingAttempts ? `${pct(w.bookingSuccess)} (${w.bookings} of ${w.bookingAttempts})` : 'no attempts'), trend: (w) => w.bookingSuccess, href: (w) => week(w, { outcome: 'booked' }) },
    { key: 'turns', label: 'Turns to a booking', explain: 'How many times the caller spoke, on calls that ended in a booking.', value: (w) => (w.avgTurnsToBooking === null ? 'no bookings' : String(w.avgTurnsToBooking)), trend: (w) => w.avgTurnsToBooking, href: (w) => week(w, { outcome: 'booked' }) },
    { key: 'transferred', label: 'Transferred to a person', explain: 'Share of calls that went to a person.', value: (w) => `${pct(w.transferredShare)} (${w.transferred})`, trend: (w) => w.transferredShare, href: (w) => week(w, { outcome: 'transferred' }) },
    { key: 'flagged', label: 'Flagged for review', explain: 'Share of calls whose summary said someone should look at them.', value: (w) => `${pct(w.flaggedShare)} (${w.flagged})`, trend: (w) => w.flaggedShare, href: (w) => week(w, { review: 'needed' }) },
    { key: 'after', label: 'After-hours calls answered', explain: 'Calls outside opening hours, all answered.', value: (w) => String(w.afterHours), trend: (w) => w.afterHours, href: (w) => week(w) },
    { key: 'cost', label: 'Cost per call', explain: 'Voice minutes at the list price, an estimate. The planner and summaries are extra.', value: (w) => money(w.costPerCall), trend: (w) => w.costPerCall, href: (w) => week(w) },
    { key: 'costBooking', label: 'Cost per booking', explain: 'The week\'s voice cost, divided by its bookings.', value: (w) => money(w.costPerBooking), trend: (w) => w.costPerBooking, href: (w) => week(w, { outcome: 'booked' }) },
  ];

  if (!isPending && !allowed) return <><PageHeader title="Quality" /><Empty title="Not available">Only owners and practice managers see quality.</Empty></>;
  const weeks = q.data?.weeks ?? [];
  const [now] = weeks;
  const oldestFirst = [...weeks].reverse();

  return (
    <>
      <PageHeader title="Quality" description="How the assistant is doing, week by week, counted from the calls. Browser test calls are left out. Open any number to see the calls behind it." />
      {q.isError && <Alert tone="danger">The numbers did not load. They try again every minute.</Alert>}
      {q.isPending || !now ? <Skeleton className="h-96" /> : (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="This week">
            {METRICS.map((m) => (
              <Link key={m.key} href={m.href(now)} className="focus-ring block rounded-lg border border-border bg-surface p-4 shadow-xs hover:border-border-strong" data-testid={`quality-${m.key}`}>
                <p className="text-sm text-text-muted">{m.label}</p>
                <p className="mt-1 text-xl font-semibold tabular-nums">{m.value(now)}</p>
                <div className="mt-2 flex items-end justify-between gap-2">
                  <p className="text-xs text-text-muted">This week, {now.calls} call{now.calls === 1 ? '' : 's'}</p>
                  <Sparkline points={oldestFirst.map((w) => m.trend(w) ?? 0)} label={`${m.label}, last ${weeks.length} weeks`} className="h-6 w-20" />
                </div>
              </Link>
            ))}
          </div>

          <Card>
            <CardHeader><CardTitle>Why the assistant said no</CardTitle></CardHeader>
            <CardContent>
              <p className="mb-3 text-sm text-text-muted">The rules the code enforced this week. A refusal is the assistant being careful: most are a caller who did not clearly say yes, or could not be verified.</p>
              {!now.refusals.length ? <p className="text-sm text-text-muted">No refusals this week.</p> : (
                <ul className="flex flex-wrap gap-2" aria-label="Refusals this week">
                  {now.refusals.map((r) => (
                    <li key={r.code}>
                      <Link href={calls({ from: now.start, to: now.end, refusal: r.code })} className="focus-ring inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-sunken">
                        {REFUSALS[r.code] ?? r.code.replace(/_/g, ' ')}<span className="font-semibold tabular-nums">{r.count}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Week by week</CardTitle></CardHeader>
            <Table density="compact">
              <THead><tr><TH>Week of</TH><TH className="text-right">Calls</TH>{METRICS.map((m) => <TH key={m.key} className="text-right" title={m.explain}>{m.label}</TH>)}</tr></THead>
              <tbody>
                {weeks.map((w) => (
                  <TRow key={w.start}>
                    <TD className="whitespace-nowrap"><Link href={week(w)} className="hover:underline">{short(w.start)}</Link></TD>
                    <TD className="text-right tabular-nums">{w.calls}</TD>
                    {METRICS.map((m) => <TD key={m.key} className="whitespace-nowrap text-right tabular-nums"><Link href={m.href(w)} className="hover:underline">{m.value(w)}</Link></TD>)}
                  </TRow>
                ))}
              </tbody>
            </Table>
          </Card>
          <p className="text-xs text-text-muted">{METRICS.map((m) => `${m.label}: ${m.explain}`).join(' ')} Cost uses ${q.data!.costPerMinute.toFixed(2)} a minute.</p>
        </div>
      )}
    </>
  );
}
