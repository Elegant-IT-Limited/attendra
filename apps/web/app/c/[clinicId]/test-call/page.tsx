// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { TestCallAllowance } from '@attendra/api/contracts';
import { useQuery } from '@tanstack/react-query';
import { Bot, Download, Mic, PhoneOff, User } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { SimulatedCall } from '@/components/calls/simulated-call';
import { FAILURES, useTestCall } from '@/components/calls/test-call';
import { PageHeader } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/controls';
import { Alert, Empty } from '@/components/ui/feedback';
import { api, useClinic } from '@/lib/api';
import { canRecord } from '@/lib/call-recording';
import { clock } from '@/lib/format';
import { limitIsTimeLeft, testCallLimitLabel } from '@/lib/test-call-limit';
import { cn } from '@/lib/utils';

const TEST_CALLS_DOC = 'https://github.com/Elegant-IT-Limited/attendra/blob/main/docs/test-calls.md';

export default function TestCallPage() {
  const { clinicId } = useParams<{ clinicId: string }>();
  const { data: me, clinic, can } = useClinic(clinicId);
  // the call itself lives in the clinic's frame (TestCallProvider), so it keeps going on other pages; this page starts it and shows it
  const { phase, captions, callId, seconds, maxSeconds, micNote, micStopped, start, end, record, setRecord, recording, saved, savedAt, saveAgain, markSaved } = useTestCall();
  const allowance = useQuery({ queryKey: ['test-call-allowance', clinicId], queryFn: () => api<TestCallAllowance>(`/clinics/${clinicId}/test-calls/allowance`), enabled: can('calls:test') });
  // only in the browser, after the first render: the server cannot know, and the two must render the same
  const [recordable, setRecordable] = useState(false);
  useEffect(() => setRecordable(canRecord()), []);
  // the captions keep the newest line in view, in their own scroll area: a long call never grows the page
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = log.current; if (el) el.scrollTop = el.scrollHeight; }, [captions]);
  const left = allowance.data?.limitSeconds == null ? null : Math.max(0, allowance.data.limitSeconds - allowance.data.usedSeconds);

  if (clinic && !can('calls:test')) return <Empty title="Not available">Your role cannot make test calls.</Empty>;
  // the page's own title above it: the menu leads here for a simulated call too
  if (me && !me.testCalls) return <><PageHeader title="Test call" /><Empty title="Test calls are off" action={<a href={TEST_CALLS_DOC} target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline">How to set up test calls</a>}>{FAILURES.voice_not_configured}</Empty>{me.simulatedCalls && <SimulatedCall clinicId={clinicId} />}</>;
  const busy = phase === 'connecting' || phase === 'live' || phase === 'ending';

  return (
    <>
      <PageHeader
        title="Test call"
        description="Talk to the receptionist through your microphone, with this clinic's live settings. It is recorded like a phone call and marked as a browser test."
      />
      <div className="grid gap-6 lg:grid-cols-[320px_1fr] lg:items-start">
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-8 text-center">
            <div className={cn('flex size-20 items-center justify-center rounded-full', phase === 'live' ? 'bg-primary text-on-primary' : 'bg-primary-soft text-primary')}>
              <Mic className="size-8" />
            </div>
            <div className="space-y-1">
              <p className="font-medium">
                {{ idle: 'Ready', connecting: 'Connecting…', live: 'Live', ending: 'Ending…', ended: 'Call ended' }[phase]}
              </p>
              {/* every limit here is the server's: the allowance before the call, the start's answer during it */}
              <p className={cn('text-sm tabular-nums', phase === 'live' && maxSeconds !== null && maxSeconds - seconds <= 60 ? 'font-medium text-warning' : 'text-text-muted')} data-testid="test-call-clock">
                {phase === 'live' ? (maxSeconds === null ? clock(seconds * 1000) : `${clock(seconds * 1000)} · ${clock(Math.max(0, maxSeconds - seconds) * 1000)} left`)
                  : phase === 'ended' ? (maxSeconds !== null && seconds >= maxSeconds - 5 ? `${clock(seconds * 1000)} · ended at the ${Math.round(maxSeconds / 60)}-minute limit for one test call` : clock(seconds * 1000))
                  : <span data-testid="test-call-limit">{allowance.isPending ? '\u00a0' : testCallLimitLabel(allowance.data)}</span>}
              </p>
            </div>
            {busy
              ? <Button variant="danger" onClick={end} disabled={phase === 'ending'}><PhoneOff /> End call</Button>
              : <Button onClick={() => void start()} disabled={left !== null && left < 15}><Mic /> {phase === 'ended' ? 'Call again' : 'Start test call'}</Button>}
            {recordable && (
              <div className="w-full text-left">
                <Checkbox id="record-test-call" checked={record} onCheckedChange={setRecord} label="Record this test call"
                  hint="Saved to your Downloads when the call ends, on this computer only. Nothing is uploaded." />
              </div>
            )}
            {recording && (
              <p role="status" className="flex items-center gap-2 text-sm font-medium text-danger" data-testid="recording-on">
                <span className="relative flex size-2.5" aria-hidden><span className="absolute inline-flex size-full rounded-full bg-danger animate-live" /><span className="relative inline-flex size-2.5 rounded-full bg-danger" /></span> Recording on this computer
              </p>
            )}
            {saved && !recording && savedAt && (
              <div role="status" className="space-y-1 text-sm" data-testid="recording-saved">
                <p className="break-all text-text-muted">Saved to your Downloads: <span className="font-medium text-text">{saved.name}</span></p>
                <button type="button" onClick={saveAgain} className="focus-ring inline-flex items-center gap-1.5 rounded-sm text-primary hover:underline"><Download className="size-4" /> Save again</button>
              </div>
            )}
            {saved && !recording && !savedAt && (
              <div role="alert" className="space-y-1 text-sm">
                <p className="text-warning">Your browser did not save it: save it now.</p>
                <a href={saved.url} download={saved.name} onClick={markSaved} className="inline-flex items-center gap-1.5 text-primary hover:underline"><Download className="size-4" /> Save the recording</a>
              </div>
            )}
            {/* the time left, unless the line above already says it */}
            {left !== null && (left < 15 || phase !== 'idle' || !limitIsTimeLeft(allowance.data)) && (
              <p className="text-sm text-text-muted" data-testid="test-minutes-left">{left < 15 ? 'No test-call time left.' : `${clock(left * 1000)} of test calls left`}</p>
            )}
            {phase === 'ended' && callId && can('calls:read') && (
              <Link href={`/c/${clinicId}/calls/${callId}`} className="text-sm text-primary hover:underline">Open the call record</Link>
            )}
            <p className="text-xs text-text-muted">
              What the assistant does here is real for this clinic: bookings, cancellations and requests. No texts are sent.{clinic?.accountLinks.length ? ' Test minutes are counted separately from your plan.' : ' Uses OpenAI credit, about $0.05 a minute.'}
            </p>
            <p className="text-xs text-text-muted">Use headphones in a quiet room. From laptop speakers the assistant can hear itself, and background voices are taken for the caller.</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Live captions</CardTitle></CardHeader>
          {/* scrollable, so it takes the keyboard's focus for the arrow keys (axe: scrollable-region-focusable), as the live page's captions do */}
          <div ref={log} tabIndex={0} className="focus-ring max-h-[32rem] min-h-48 space-y-4 overflow-y-auto px-5 py-4 max-md:max-h-[22rem]" role="log" aria-label="Live captions" aria-live="off">
            {micStopped && <Alert tone="warn">Your microphone stopped. Hang up and call again.</Alert>}
            {micNote && <Alert tone="warn">{micNote}</Alert>}
            {captions.length === 0 && <p className="text-sm text-text-muted">What you and the assistant say appears here.</p>}
            {captions.map((c, i) => {
              const agent = c.speaker === 'agent';
              return (
                <div key={i} className={cn('flex gap-3', !agent && 'flex-row-reverse')}>
                  <div className={cn('flex size-8 shrink-0 items-center justify-center rounded-full', agent ? 'bg-primary-soft text-primary' : 'bg-surface-sunken text-text-muted')}>
                    {agent ? <Bot className="size-4" /> : <User className="size-4" />}
                  </div>
                  <p className={cn('max-w-[80%] rounded-lg px-3.5 py-2 text-sm leading-relaxed', agent ? 'bg-surface-sunken' : 'bg-primary text-on-primary')}>{c.text || '…'}</p>
                </div>
              );
            })}
          </div>
        </Card>
      </div>
      {me?.simulatedCalls && <SimulatedCall clinicId={clinicId} />}
    </>
  );
}
