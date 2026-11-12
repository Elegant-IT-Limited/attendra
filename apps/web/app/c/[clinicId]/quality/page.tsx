// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { QualityWeek } from '@attendra/api/contracts';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/shell';
import { Sparkline } from '@/components/ui/bits';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, Empty, Skeleton } from '@/components/ui/feedback';
import { Table, TD, TH, THead, TRow } from '@/components/ui/table';
import { useClinic, useClinicConfig } from '@/lib/api';
import { dayTitle, REFUSALS, usd } from '@/lib/format';
import { testCallsLeftOut } from '@/lib/quality';
import { pageData } from '@/lib/page-data';

const pct = (n: number | null) => (n === null ? '—' : `${Math.round(n * 100)}%`);
const money = (n: number | null) => (n === null ? '—' : usd(n));
// "29 Sep", day first like every other date in the dashboard
const short = (d: string) => dayTitle(d, 'short').replace(/^\w+ /, '');

type Metric = { key: string; label: string; explain: string; value: (w: QualityWeek) => string; trend: (w: QualityWeek) => number | null; href: (w: QualityWeek) => string; sub?: (w: QualityWeek) => string };

/** The no-shows card and column: the server's share and count, as it sent them (a test reads this against the API). */
const noShowText = (w: Pick<QualityWeek, 'noShowShare' | 'noShows'>) => (w.noShowShare === null ? '—' : `${pct(w.noShowShare)} (${w.noShows})`);

/**
 * How well the assistant is doing, week by week, from database counts. Every number
 * opens the calls behind it. No patient data: outcomes, codes, counts and times.
 */
export default function QualityPage() {
  const { clinicId } = useParams<{ clinicId: string }>();
  const { can, isPending, clinic } = useClinic(clinicId);
  // a hosted clinic pays a plan, not the voice minutes: the cost estimates are for people who run Attendra themselves
  const hosted = !!clinic?.accountLinks.length;
  // a clinic that books in the morning counts what it kept after hours as requests, not bookings
  const takesRequests = useClinicConfig(clinicId).data?.afterHours === 'requests';
  const allowed = can('quality:read');
  // the weeks since the clinic signed up, half a year at most: the server trims them to its sign-up week
  const q = useQuery({ ...pageData.quality(clinicId), enabled: allowed, refetchInterval: 60_000 });
  const calls = (params: Record<string, string>) => `/c/${clinicId}/calls?${new URLSearchParams(params)}`;
  const week = (w: QualityWeek, extra: Record<string, string> = {}) => calls({ from: w.start, to: w.end, ...extra });

  const ALL: Metric[] = [
    { key: 'containment', label: 'Handled without staff', explain: 'Calls the assistant finished itself: booked, moved, cancelled or answered.', value: (w) => pct(w.containmentRate), trend: (w) => w.containmentRate, href: (w) => week(w) },
    { key: 'booking', label: 'Booking success', explain: 'Bookings made, out of calls where the assistant proposed a time.', value: (w) => (w.bookingAttempts ? `${pct(w.bookingSuccess)} (${w.bookings} of ${w.bookingAttempts})` : '—'), trend: (w) => w.bookingSuccess, href: (w) => week(w, { outcome: 'booked' }) },
    // the server's avgTurnsToBooking: the caller's lines in the transcript, averaged over the week's calls that booked or
    // moved a visit (core qualityOf), so "17" is 17 times the caller spoke on such a call, start to end
    { key: 'turns', label: 'Caller turns per booking, average', explain: 'On calls that booked or moved a visit: how many times the caller spoke, start to end, on average. Fewer turns is a smoother call.', value: (w) => (w.avgTurnsToBooking === null ? '—' : String(w.avgTurnsToBooking)), trend: (w) => w.avgTurnsToBooking, href: (w) => week(w, { outcome: 'booked' }),
      sub: (w) => (w.bookings ? `Times the caller spoke, over ${w.bookings} booked call${w.bookings === 1 ? '' : 's'}` : 'Times the caller spoke, on a booked call') },
    { key: 'transferred', label: 'Transferred to a person', explain: 'Share of calls that went to a person.', value: (w) => (w.transferredShare === null ? '—' : `${pct(w.transferredShare)} (${w.transferred})`), trend: (w) => w.transferredShare, href: (w) => week(w, { outcome: 'transferred' }) },
    { key: 'flagged', label: 'Flagged for review', explain: 'Share of calls someone should look at: emergency language, a caller who could not be verified, security or abusive language, an upset caller, or something left unfinished with no request for the team. Hang-ups before the caller said what they wanted, and calm calls that already made a request, are not counted.', value: (w) => (w.flaggedShare === null ? '—' : `${pct(w.flaggedShare)} (${w.flagged})`), trend: (w) => w.flaggedShare, href: (w) => week(w, { review: 'needed' }) },
    { key: 'after', label: 'After-hours calls answered', explain: 'Calls outside opening hours, all answered.', value: (w) => String(w.afterHours), trend: (w) => w.afterHours, href: (w) => week(w) },
    takesRequests
      ? { key: 'afterRequests', label: 'Requests taken after hours', explain: 'Calls while the clinic was closed that left a request for the team to book in the morning: calls that would have gone to voicemail.', value: (w) => String(w.afterHoursRequests), trend: (w) => w.afterHoursRequests, href: (w) => week(w, { outcome: 'task_created' }) }
      : { key: 'afterBooked', label: 'Bookings made after hours', explain: 'Visits booked while the clinic was closed: calls that would have gone to voicemail.', value: (w) => String(w.afterHoursBookings), trend: (w) => w.afterHoursBookings, href: (w) => week(w, { outcome: 'booked' }) },
    { key: 'emergencies', label: 'Emergencies sent on', explain: 'Calls where the emergency script ran.', value: (w) => String(w.emergencies), trend: (w) => w.emergencies, href: (w) => week(w, { emergency: 'true' }) },
    { key: 'refills', label: 'Refill requests', explain: 'Refill requests the assistant took for the team.', value: (w) => String(w.refillRequests), trend: (w) => w.refillRequests, href: (w) => week(w) },
    { key: 'noShows', label: 'No-shows', explain: 'Visits the desk marked a no-show, out of the visits due that week that have started. A visit nobody marked is counted as due, not as a no-show; cancelled visits are left out.', value: noShowText, trend: (w) => w.noShowShare, href: (w) => `/c/${clinicId}/schedule?${new URLSearchParams({ view: 'agenda', days: '7', date: w.start })}`, sub: (w) => `This week, ${w.visitsDue} visit${w.visitsDue === 1 ? '' : 's'} due` },
    { key: 'cost', label: 'Cost per call', explain: 'Voice minutes at the list price, an estimate. The planner and summaries are extra.', value: (w) => money(w.costPerCall), trend: (w) => w.costPerCall, href: (w) => week(w) },
    { key: 'costBooking', label: 'Cost per booking', explain: 'The week\'s voice cost, divided by its bookings.', value: (w) => money(w.costPerBooking), trend: (w) => w.costPerBooking, href: (w) => week(w, { outcome: 'booked' }) },
  ];
  const METRICS = ALL.filter((m) => !hosted || !m.key.startsWith('cost'));

  if (!isPending && !allowed) return <><PageHeader title="Quality" /><Empty title="Not available">Only owners and practice managers see quality.</Empty></>;
  const weeks = q.data?.weeks ?? [];
  const [now] = weeks;
  const oldestFirst = [...weeks].reverse();
  // a tester saw "No calls this week yet" beside a Calls page full of test calls: say what was left out, and where it is
  const leftOut = now ? testCallsLeftOut(now.testCallsLeftOut) : null;
  const seeTests = now ? <Link href={week(now, { channel: 'web' })} className="font-medium underline" data-testid="quality-test-calls-link">See {now.testCallsLeftOut === 1 ? 'it' : 'them'} in Calls</Link> : null;

  return (
    <>
      <PageHeader title="Quality" description="How the assistant is doing, week by week, counted from the calls. Browser test calls are left out. Open any number to see the calls behind it." />
      {q.isError && <Alert tone="danger">The numbers did not load. They try again every minute.</Alert>}
      {q.isPending || !now ? <Skeleton className="h-96" /> : (
        <div className="space-y-6">
          {now.calls === 0 && !leftOut && <Alert>No calls this week yet. The numbers fill in as calls come in; a dash means there is nothing to count.</Alert>}
          {now.calls === 0 && leftOut && <div data-testid="quality-test-calls"><Alert>No phone calls this week yet. {leftOut} {seeTests}.</Alert></div>}
          {now.calls > 0 && leftOut && <p className="text-sm text-text-muted" data-testid="quality-test-calls">{leftOut} {seeTests}.</p>}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="This week">
            {METRICS.map((m) => (
              <Link key={m.key} href={m.href(now)} className="focus-ring block rounded-lg border border-border bg-surface p-4 shadow-xs hover:border-border-strong" data-testid={`quality-${m.key}`}>
                <p className="text-sm text-text-muted">{m.label}</p>
                <p className="mt-1 text-xl font-semibold tabular-nums">{m.value(now)}</p>
                <div className="mt-2 flex items-end justify-between gap-2">
                  <p className="text-xs text-text-muted">{m.sub ? m.sub(now) : `This week, ${now.calls} call${now.calls === 1 ? '' : 's'}`}</p>
                  <Sparkline points={oldestFirst.map((w) => m.trend(w) ?? 0)} label={`${m.label}, ${weeks.length === 1 ? 'this week' : `last ${weeks.length} weeks`}`} className="h-6 w-20" />
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
            <Table density="compact" label="Week by week">
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
          <details className="group rounded-lg border border-border bg-surface text-sm shadow-xs">
            <summary className="focus-ring cursor-pointer list-none rounded-lg px-4 py-2.5 font-medium text-text-muted hover:text-text [&::-webkit-details-marker]:hidden">What each number means</summary>
            <dl className="grid gap-x-6 gap-y-3 border-t border-border px-4 py-3 md:grid-cols-2">
              {METRICS.map((m) => <div key={m.key}><dt className="font-medium">{m.label}</dt><dd className="text-text-muted">{m.explain}</dd></div>)}
              {!hosted && <div><dt className="font-medium">Price per minute</dt><dd className="text-text-muted">Costs use ${q.data!.costPerMinute.toFixed(2)} a minute.</dd></div>}
            </dl>
          </details>
        </div>
      )}
    </>
  );
}
