// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { Mic, MicOff, PhoneOff } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useClinic } from '@/lib/api';
import { clock } from '@/lib/format';
import { useTestCall } from './test-call';

/**
 * A test call going on while the owner moves around the dashboard, like a huddle bar:
 * the clinic, the time, mute, hang up and the way back to Test call. On every page of
 * the clinic while a call is connecting or live, and after a microphone that stopped,
 * until that has been read.
 */
export function CallBar() {
  const call = useTestCall();
  const { clinic } = useClinic(call.clinicId);
  const pathname = usePathname();
  const [now, setNow] = useState(() => Date.now());
  const simulated = call.simulated;
  useEffect(() => {
    if (!simulated) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [simulated]);

  const browser = call.phase === 'connecting' || call.phase === 'live' || call.phase === 'ending';
  if (!browser && !simulated && !call.micStopped) return null;
  const testCall = `/c/${call.clinicId}/test-call`;
  const status = call.micStopped ? 'Your microphone stopped. Hang up and call again.'
    : browser ? (call.phase === 'connecting' ? 'Connecting…' : call.phase === 'ending' ? 'Ending…' : clock(call.seconds * 1000))
      : clock(Math.max(0, now - simulated!.startedAt));

  return (
    <div role="region" aria-label="Test call in progress" data-testid="call-bar"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-primary-soft px-4 py-2 text-sm text-text md:px-8">
      <span className="flex min-w-0 items-center gap-2 font-medium">
        <span className={browser || simulated ? 'size-2 shrink-0 animate-pulse rounded-full bg-primary' : 'size-2 shrink-0 rounded-full bg-warning'} aria-hidden />
        <span className="truncate">{simulated && !browser ? 'Simulated call' : 'Test call'}{clinic ? `, ${clinic.name}` : ''}</span>
      </span>
      <span className={call.micStopped ? 'font-medium' : 'tabular-nums'} data-testid="call-bar-status" role={call.micStopped ? 'alert' : undefined}>{status}</span>
      <span className="ml-auto flex items-center gap-2">
        {!pathname.startsWith(testCall) && <Link href={testCall} className="underline underline-offset-2 hover:no-underline">Back to Test call</Link>}
        {browser && call.phase !== 'connecting' && !call.micStopped && (
          <Button size="sm" variant="outline" aria-pressed={call.muted} onClick={call.toggleMute}>{call.muted ? <MicOff /> : <Mic />} {call.muted ? 'Unmute' : 'Mute'}</Button>
        )}
        <Button size="sm" variant="danger" disabled={call.phase === 'ending'}
          onClick={() => { if (browser) call.end(); if (simulated) call.endSimulated(); if (call.micStopped) call.dismiss(); }}>
          <PhoneOff /> Hang up
        </Button>
      </span>
    </div>
  );
}
