// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { LiveCall } from '@attendra/api/contracts';
import { Siren } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { chime, useEmergencyAlerts, useLiveCalls } from '@/lib/live';
import { clock } from '@/lib/format';
import { cn } from '@/lib/utils';

function useNow(every = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), every); return () => clearInterval(t); }, [every]);
  return now;
}

/** "Waiting for a yes", "Finding open times", or "Talking". */
const doingLabel = (c: LiveCall) => (c.waitingForYes ? 'Waiting for a yes' : c.doing ? `${c.doing[0]!.toUpperCase()}${c.doing.slice(1)}` : 'Talking');

/**
 * The calls going on now, on Today and Calls. Nothing is shown when there are none.
 * Each call has its length, who is calling once they are verified, and what the
 * assistant is doing; with `calls:read` it opens the live call.
 */
export function LiveNow({ clinicId, canWatch }: { clinicId: string; canWatch: boolean }) {
  const live = useLiveCalls(clinicId);
  const now = useNow();
  const calls = live.data?.calls ?? [];
  if (!calls.length) return null;
  return (
    <Card className="mb-6" aria-label="Live now">
      <div className="flex items-center gap-2 border-b border-border px-5 py-3">
        <span className="relative flex size-2.5" aria-hidden><span className="absolute inline-flex size-full rounded-full bg-danger animate-live" /><span className="relative inline-flex size-2.5 rounded-full bg-danger" /></span>
        <h2 className="text-base font-semibold">Live now</h2>
        <span className="text-sm text-text-muted">{calls.length} call{calls.length === 1 ? '' : 's'}</span>
      </div>
      <ul className="divide-y divide-border" aria-label="Live calls">
        {calls.map((c) => {
          const body = (
            <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3', c.emergency && 'bg-danger-soft/50', canWatch && 'hover:bg-surface-sunken')}>
              <span className="w-14 font-mono text-sm tabular-nums">{clock(Math.max(0, now - Date.parse(c.startedAt)))}</span>
              <span className="min-w-40 flex-1 text-sm font-medium">{c.verified ? `Verified: ${c.caller ?? 'yes'}` : 'Not verified yet'}</span>
              <span className="text-sm text-text-muted">{doingLabel(c)}</span>
              {c.emergency && <Badge tone="danger"><Siren aria-hidden /> Emergency</Badge>}
              {c.channel === 'web' && <Badge tone="accent">Browser test</Badge>}
              {canWatch && <span className="text-sm text-primary">Watch</span>}
            </div>
          );
          return <li key={c.callId}>{canWatch ? <Link href={`/c/${clinicId}/calls/${c.callId}/live`} className="block focus-ring">{body}</Link> : body}</li>;
        })}
      </ul>
    </Card>
  );
}

/**
 * Rings when an emergency starts on any live call, for people who turned it on. It
 * runs on every page of the clinic, and only polls when it is on.
 */
export function EmergencyAlerts({ clinicId }: { clinicId: string }) {
  const [on] = useEmergencyAlerts();
  const live = useLiveCalls(clinicId, on, 10_000);
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    const flagged = (live.data?.calls ?? []).filter((c) => c.emergency).map((c) => c.callId);
    // the first answer is where things stand, not news
    if (known.current === null) { if (live.data) known.current = new Set(flagged); return; }
    const fresh = flagged.filter((id) => !known.current!.has(id));
    for (const id of fresh) known.current.add(id);
    if (!fresh.length) return;
    chime();
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification('Emergency language on a live call', { body: 'Open Attendra to watch the call.', tag: `emergency-${fresh[0]}` });
    }
  }, [live.data]);
  return null;
}
