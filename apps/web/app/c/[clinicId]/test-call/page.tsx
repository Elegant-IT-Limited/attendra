// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { TestCall } from '@attendra/api/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { Bot, Mic, PhoneOff, User } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PageHeader } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, Empty } from '@/components/ui/feedback';
import { api, ApiFailure, useClinic } from '@/lib/api';
import { clock } from '@/lib/format';
import { cn } from '@/lib/utils';

type Phase = 'idle' | 'connecting' | 'live' | 'ending' | 'ended';
type Caption = { speaker: 'caller' | 'agent'; text: string };

const FAILURES: Record<string, string> = {
  microphone: 'The browser did not give Attendra the microphone. Allow it for this site and try again.',
  voice_not_configured: 'Test calls are not set up on this server. The voice service needs an OpenAI API key; docs/test-calls.md explains it.',
  voice_unavailable: 'The voice service could not start the call. Check the OpenAI API key and its credit, then try again.',
  test_call_limit: 'This clinic already has two test calls open. End one, or wait for it to finish.',
  connection: 'The audio connection dropped.',
};

/** Resolves once the browser has all its network candidates, so the offer is complete in one request. */
function gathered(pc: RTCPeerConnection, timeoutMs = 3000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise<void>((resolve) => {
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') resolve(); });
    setTimeout(resolve, timeoutMs);
  });
}

/** One attempt: everything it opened, so ending it (from any state) closes all of it. */
interface Attempt {
  cancelled: boolean;
  /** OpenAI said session.started on the data channel, so it will act on session.close there. */
  started?: boolean;
  ending?: boolean;
  mic?: MediaStream;
  peer?: RTCPeerConnection;
  events?: RTCDataChannel;
  callId?: string;
}

export default function TestCallPage() {
  const { clinicId } = useParams<{ clinicId: string }>();
  const { data: me, clinic, can } = useClinic(clinicId);
  const queries = useQueryClient();
  const [phase, setPhase] = useState<Phase>('idle');
  const [failure, setFailure] = useState<string | null>(null);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [callId, setCallId] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [maxSeconds, setMaxSeconds] = useState(300);
  const attempt = useRef<Attempt | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  /** Ends a started session through the API; keepalive lets the request outlive a closed tab. */
  const endRemote = useCallback((id: string) => {
    void fetch(`/api/v1/clinics/${clinicId}/test-calls/${id}/end`, { method: 'POST', credentials: 'same-origin', keepalive: true }).catch(() => {});
  }, [clinicId]);

  /**
   * Stops the microphone and the connection, and ends the session on OpenAI's side
   * unless it has already closed: over the data channel, and through the API in case
   * the channel never opened or closes before the command goes out.
   */
  const release = useCallback((a: Attempt, sessionOpen = true) => {
    if (!a.cancelled && sessionOpen) {
      if (a.events?.readyState === 'open') a.events.send(JSON.stringify({ type: 'session.close' }));
      if (a.callId) endRemote(a.callId);
    }
    a.cancelled = true;
    a.events?.close();
    a.peer?.close();
    a.mic?.getTracks().forEach((t) => t.stop());
    if (attempt.current === a) attempt.current = null;
  }, [endRemote]);

  const finish = useCallback((a: Attempt, next: Phase = 'ended', sessionOpen = true) => {
    if (attempt.current !== a) return;
    release(a, sessionOpen);
    setPhase(next);
    void queries.invalidateQueries({ queryKey: ['calls', clinicId] });
  }, [clinicId, queries, release]);

  const caption = (speaker: Caption['speaker'], delta: string) => setCaptions((all) => {
    const last = all.at(-1);
    return last?.speaker === speaker ? [...all.slice(0, -1), { speaker, text: last.text + delta }] : [...all, { speaker, text: delta }];
  });

  async function start() {
    if (attempt.current) return;
    const a: Attempt = { cancelled: false };
    attempt.current = a;
    setFailure(null); setCaptions([]); setCallId(null); setSeconds(0); setPhase('connecting');
    const fail = (key: string) => { setFailure(FAILURES[key] ?? FAILURES.voice_unavailable!); finish(a, 'idle'); };

    try {
      a.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      return a.cancelled ? undefined : fail('microphone');
    }
    if (a.cancelled) return release(a); // left the page while the browser asked for the microphone

    const peer = new RTCPeerConnection();
    a.peer = peer;
    for (const track of a.mic.getAudioTracks()) peer.addTrack(track, a.mic);
    peer.ontrack = (e) => { if (audio.current) audio.current.srcObject = e.streams[0] ?? null; };
    // A remote close does not always arrive as session.closed or as 'failed'; any of these ends the page's side.
    let dropped: ReturnType<typeof setTimeout> | undefined;
    peer.onconnectionstatechange = () => {
      clearTimeout(dropped);
      const state = peer.connectionState;
      if (state === 'failed' && !a.ending) setFailure(FAILURES.connection!);
      if (state === 'failed' || state === 'closed') finish(a, a.callId ? 'ended' : 'idle');
      if (state === 'disconnected') dropped = setTimeout(() => finish(a, 'ended'), 10_000);
    };
    // The channel must exist before the offer, or the offer does not include it.
    const events = peer.createDataChannel('oai-events');
    a.events = events;
    events.onopen = () => { if (!a.cancelled) setPhase('live'); };
    events.onclose = () => finish(a, 'ended', false);
    events.onmessage = (m) => {
      let e: { type?: string; delta?: string };
      try { e = JSON.parse(String(m.data)); } catch { return; }
      if (e.type === 'session.started') a.started = true;
      else if (e.type === 'session.input_transcript.delta' && e.delta) caption('caller', e.delta);
      else if (e.type === 'session.output_transcript.delta' && e.delta) caption('agent', e.delta);
      else if (e.type === 'session.closed') finish(a, 'ended', false);
    };

    try {
      await peer.setLocalDescription(await peer.createOffer());
      await gathered(peer);
      if (a.cancelled) return;
      const res = await api<TestCall>(`/clinics/${clinicId}/test-calls`, { method: 'POST', body: JSON.stringify({ sdp: peer.localDescription!.sdp }) });
      if (a.cancelled) return endRemote(res.callId); // left or ended while the call was starting
      a.callId = res.callId;
      setCallId(res.callId);
      setMaxSeconds(res.maxSeconds);
      await peer.setRemoteDescription({ type: 'answer', sdp: res.sdp });
    } catch (err) {
      if (a.cancelled) return;
      fail(err instanceof ApiFailure ? err.body.error : 'voice_unavailable');
    }
  }

  /** Asks OpenAI to end the session, so the call record gets its final length. */
  function end() {
    const a = attempt.current;
    if (!a) return;
    // before the session is up, end it through the API right away
    if (!a.started || a.events?.readyState !== 'open') return finish(a, a.callId ? 'ended' : 'idle');
    a.ending = true;
    setPhase('ending');
    a.events.send(JSON.stringify({ type: 'session.close' }));
    setTimeout(() => finish(a), 15_000); // no session.closed in time: end it through the API as well
  }

  useEffect(() => {
    if (phase !== 'live') return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  // Leaving the page ends the call, in whatever state it is: navigating away inside
  // the app unmounts the page, while closing or reloading the tab only fires pagehide.
  useEffect(() => {
    const leave = () => { if (attempt.current) release(attempt.current); };
    window.addEventListener('pagehide', leave);
    return () => { window.removeEventListener('pagehide', leave); leave(); };
  }, [release]);

  if (clinic && !can('calls:test')) return <Empty title="Not available">Your role cannot make test calls.</Empty>;
  if (me && !me.testCalls) return <Empty title="Test calls are off">{FAILURES.voice_not_configured}</Empty>;
  const busy = phase === 'connecting' || phase === 'live' || phase === 'ending';

  return (
    <>
      <PageHeader
        title="Test call"
        description="Talk to the receptionist through your microphone, with this clinic's live settings. It is recorded like a phone call and marked as a browser test."
      />
      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-8 text-center">
            <div className={cn('flex size-20 items-center justify-center rounded-full', phase === 'live' ? 'bg-primary text-on-primary' : 'bg-primary-soft text-primary')}>
              <Mic className="size-8" />
            </div>
            <div className="space-y-1">
              <p className="font-medium">
                {{ idle: 'Ready', connecting: 'Connecting…', live: 'Live', ending: 'Ending…', ended: 'Call ended' }[phase]}
              </p>
              <p className="text-sm tabular-nums text-text-muted">{phase === 'live' || phase === 'ended' ? clock(seconds * 1000) : `Test calls end on their own after ${Math.round(maxSeconds / 60)} minutes`}</p>
            </div>
            {busy
              ? <Button variant="danger" onClick={end} disabled={phase === 'ending'}><PhoneOff /> End call</Button>
              : <Button onClick={() => void start()}><Mic /> {phase === 'ended' ? 'Call again' : 'Start test call'}</Button>}
            {phase === 'ended' && callId && can('calls:read') && (
              <Link href={`/c/${clinicId}/calls/${callId}`} className="text-sm text-primary hover:underline">Open the call record</Link>
            )}
            <p className="text-xs text-text-muted">
              What the assistant does here is real for this clinic: bookings, cancellations and tasks. No texts are sent. Uses OpenAI credit, about $0.05 a minute.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Live captions</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {failure && <Alert tone="danger">{failure}</Alert>}
            {captions.length === 0 && !failure && <p className="text-sm text-text-muted">What you and the assistant say appears here.</p>}
            {captions.map((c, i) => {
              const agent = c.speaker === 'agent';
              return (
                <div key={i} className={cn('flex gap-3', !agent && 'flex-row-reverse')}>
                  <div className={cn('flex size-8 shrink-0 items-center justify-center rounded-full', agent ? 'bg-primary-soft text-primary' : 'bg-surface-sunken text-text-muted')}>
                    {agent ? <Bot className="size-4" /> : <User className="size-4" />}
                  </div>
                  <p className={cn('max-w-[80%] rounded-lg px-3.5 py-2 text-sm leading-relaxed', agent ? 'bg-surface-sunken' : 'bg-primary text-on-primary')}>{c.text}</p>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>
      <audio ref={audio} autoPlay className="hidden" />
    </>
  );
}
