// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { LiveCalls, TestCall } from '@attendra/api/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useProblem } from '@/components/ui/toast';
import { api, ApiFailure, newKey } from '@/lib/api';
import { type SavedRecording, startCallRecording } from '@/lib/call-recording';
import { MIC_CONSTRAINTS, micCheck, micWarning } from '@/lib/mic';

export type Phase = 'idle' | 'connecting' | 'live' | 'ending' | 'ended';
/** `item`: the Realtime engine's id for a caller's turn, whose words arrive after the reply to it starts. */
export type Caption = { speaker: 'caller' | 'agent'; text: string; item?: string };

export const FAILURES: Record<string, string> = {
  microphone: 'The browser did not give Attendra the microphone. Allow it for this site and try again.',
  voice_not_configured: 'Test calls are not set up on this server. The voice service needs an OpenAI API key.',
  voice_unavailable: 'The voice service could not start the call. Check the OpenAI API key and its credit, then try again.',
  test_call_limit: 'This clinic already has two test calls open. End one, or wait for it to finish.',
  test_minutes_used: 'This clinic has used all its test-call minutes.',
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
  /** The assistant's audio, as the browser plays it. */
  remote?: MediaStream;
  peer?: RTCPeerConnection;
  events?: RTCDataChannel;
  callId?: string;
}

/** A scripted call the local demo plays on the server: no microphone, it runs until it is ended. */
interface Simulated { callId: string; startedAt: number; seen: boolean }

interface TestCallState {
  clinicId: string;
  phase: Phase;
  captions: Caption[];
  callId: string | null;
  seconds: number;
  maxSeconds: number;
  micNote: string | null;
  /** The microphone track ended under the call (another app took it, the phone locked). */
  micStopped: boolean;
  muted: boolean;
  simulated: Simulated | null;
  start: () => Promise<void>;
  end: () => void;
  toggleMute: () => void;
  /** Puts the bar away once a stopped microphone has been read about. */
  dismiss: () => void;
  startSimulated: () => Promise<string>;
  endSimulated: () => void;
  /** Ends whatever is going on at once, before signing out. */
  hangUpNow: () => void;
  /** "Record this test call": ticked, the call is recorded on this computer while it is live. */
  record: boolean;
  setRecord: (on: boolean) => void;
  /** Recording now, on this computer only. */
  recording: boolean;
  /** The last call's recording, held in this tab, to save as a file. Never uploaded. */
  saved: SavedRecording | null;
}

const TestCallContext = createContext<TestCallState | null>(null);

export function useTestCall() {
  const state = useContext(TestCallContext);
  if (!state) throw new Error('useTestCall outside TestCallProvider');
  return state;
}

/**
 * The browser test call, held by the clinic's frame rather than the Test call page, so
 * moving between dashboard pages keeps it: the peer connection, the data channel, the
 * microphone, the timer and the captions live here, and the call bar shows it on every
 * page. It ends on hang up, at the time limit, when the tab is closed or reloaded
 * (pagehide), on sign-out, and when another clinic is opened.
 */
export function TestCallProvider({ clinicId, children }: { clinicId: string; children: ReactNode }) {
  const queries = useQueryClient();
  const [phase, setPhase] = useState<Phase>('idle');
  // why the call did not start or dropped opens in a dialog; the call area says it is ready again
  const problem = useProblem();
  const setFailure = useCallback((message: string | null) => { if (message) problem({ title: 'The test call stopped', message }); }, [problem]);
  const [micNote, setMicNote] = useState<string | null>(null);
  const [micStopped, setMicStopped] = useState(false);
  const [muted, setMuted] = useState(false);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [callId, setCallId] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [maxSeconds, setMaxSeconds] = useState(300);
  const [simulated, setSimulated] = useState<Simulated | null>(null);
  const simulatedId = useRef<string | null>(null);
  const attempt = useRef<Attempt | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  // a recording of the call, made and kept in this browser only
  const [record, setRecord] = useState(false);
  const [recording, setRecording] = useState(false);
  const [saved, setSaved] = useState<SavedRecording | null>(null);
  const [remoteUp, setRemoteUp] = useState(false);
  const recorder = useRef<ReturnType<typeof startCallRecording> | null>(null);

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
    setMuted(false);
    void queries.invalidateQueries({ queryKey: ['calls', clinicId] });
    void queries.invalidateQueries({ queryKey: ['test-call-allowance', clinicId] });
  }, [clinicId, queries, release]);

  const caption = (speaker: Caption['speaker'], delta: string) => setCaptions((all) => {
    const last = all.at(-1);
    return last?.speaker === speaker && !last.item ? [...all.slice(0, -1), { speaker, text: last.text + delta }] : [...all, { speaker, text: delta }];
  });
  // Realtime: a caller's turn holds its place in the order it was said; its words fill in once transcribed
  const heard = (item: string, text: string | null) => setCaptions((all) => {
    const at = all.findIndex((c) => c.item === item);
    if (text === null) return at >= 0 ? all : [...all, { speaker: 'caller', text: '', item }];
    if (at < 0) return [...all, { speaker: 'caller', text, item }];
    return all.map((c, i) => (i === at ? { ...c, text: c.text + text } : c));
  });

  /** Asks OpenAI to end the session, so the call record gets its final length. */
  const end = useCallback(() => {
    const a = attempt.current;
    if (!a) return;
    // before the session is up, end it through the API right away
    if (!a.started || a.events?.readyState !== 'open') return finish(a, a.callId ? 'ended' : 'idle');
    if (a.ending) return;
    a.ending = true;
    setPhase('ending');
    a.events.send(JSON.stringify({ type: 'session.close' }));
    setTimeout(() => finish(a), 15_000); // no session.closed in time: end it through the API as well
  }, [finish]);

  async function start() {
    if (attempt.current) return;
    const a: Attempt = { cancelled: false };
    attempt.current = a;
    setFailure(null); setMicNote(null); setMicStopped(false); setMuted(false); setCaptions([]); setCallId(null); setSeconds(0); setPhase('connecting');
    setRemoteUp(false);
    setSaved((old) => { if (old) URL.revokeObjectURL(old.url); return null; });
    const fail = (key: string) => { setFailure(FAILURES[key] ?? FAILURES.voice_unavailable!); finish(a, 'idle'); };

    try {
      a.mic = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
    } catch {
      return a.cancelled ? undefined : fail('microphone');
    }
    if (a.cancelled) return release(a); // ended (signed out, another clinic) while the browser asked for the microphone
    // what the browser actually applied, which can differ from what we asked for
    const track = a.mic.getAudioTracks()[0];
    setMicNote(track ? micWarning(micCheck(track.getSettings())) : null);
    // another app or tab took the microphone, or the phone locked: the assistant would hear
    // nothing from here on, so the call ends rather than running on in silence
    for (const t of a.mic.getAudioTracks()) {
      t.addEventListener('ended', () => {
        if (a.cancelled) return;
        setMicStopped(true);
        end();
      });
    }

    const peer = new RTCPeerConnection();
    a.peer = peer;
    for (const track of a.mic.getAudioTracks()) peer.addTrack(track, a.mic);
    peer.ontrack = (e) => {
      if (audio.current) audio.current.srcObject = e.streams[0] ?? null;
      a.remote = e.streams[0];
      setRemoteUp(!!a.remote);
    };
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
      let e: { type?: string; delta?: string; item_id?: string };
      try { e = JSON.parse(String(m.data)); } catch { return; }
      if (e.type === 'session.started') a.started = true;
      // GPT-Live's caption events
      else if (e.type === 'session.input_transcript.delta' && e.delta) caption('caller', e.delta);
      else if (e.type === 'session.output_transcript.delta' && e.delta) caption('agent', e.delta);
      // the Realtime engine's: the caller's turn is placed when it ends, and filled in as it is transcribed
      else if (e.type === 'input_audio_buffer.committed' && e.item_id) heard(e.item_id, null);
      else if (e.type === 'conversation.item.input_audio_transcription.delta' && e.delta) { if (e.item_id) heard(e.item_id, e.delta); else caption('caller', e.delta); }
      else if (e.type === 'response.output_audio_transcript.delta' && e.delta) caption('agent', e.delta);
      else if (e.type === 'session.closed') finish(a, 'ended', false);
    };

    try {
      await peer.setLocalDescription(await peer.createOffer());
      await gathered(peer);
      if (a.cancelled) return;
      const res = await api<TestCall>(`/clinics/${clinicId}/test-calls`, { method: 'POST', body: JSON.stringify({ sdp: peer.localDescription!.sdp }) });
      if (a.cancelled) return endRemote(res.callId); // ended while the call was starting
      a.callId = res.callId;
      setCallId(res.callId);
      setMaxSeconds(res.maxSeconds);
      await peer.setRemoteDescription({ type: 'answer', sdp: res.sdp });
    } catch (err) {
      if (a.cancelled) return;
      fail(err instanceof ApiFailure ? err.body.error : 'voice_unavailable');
    }
  }

  // "Record this test call": from when the call is live until it has ended (its goodbye included), or the box is unticked
  useEffect(() => {
    const a = attempt.current;
    const on = record && (phase === 'live' || phase === 'ending');
    if (on && remoteUp && a?.remote && !recorder.current) {
      try {
        recorder.current = startCallRecording(a.remote, a.mic ?? null);
        setRecording(true);
      } catch {
        problem({ title: 'The recording did not start', message: 'This browser could not record the call. The call goes on without a recording.' });
      }
    } else if (!on && recorder.current) {
      const r = recorder.current;
      recorder.current = null;
      setRecording(false);
      void r.stop().then(setSaved);
    }
  }, [record, phase, remoteUp, problem]);

  const toggleMute = useCallback(() => {
    const a = attempt.current;
    if (!a?.mic) return;
    const next = !muted;
    for (const t of a.mic.getAudioTracks()) t.enabled = !next;
    setMuted(next);
  }, [muted]);

  // the clock, and the time limit: the server closes the session at its limit, and the page does not wait for it
  useEffect(() => {
    if (phase !== 'live') return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);
  useEffect(() => { if (phase === 'live' && seconds >= maxSeconds) end(); }, [phase, seconds, maxSeconds, end]);

  const startSimulated = useCallback(async () => {
    const { callId: id } = await api<{ callId: string }>(`/clinics/${clinicId}/test-calls/simulated`, { method: 'POST' });
    simulatedId.current = id;
    setSimulated({ callId: id, startedAt: Date.now(), seen: false });
    return id;
  }, [clinicId]);
  const endSimulated = useCallback((keepalive = false) => {
    const id = simulatedId.current;
    simulatedId.current = null;
    setSimulated(null);
    if (id) void fetch(`/api/v1/clinics/${clinicId}/calls/${id}/live/end`, { method: 'POST', credentials: 'same-origin', keepalive, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: newKey() }) }).catch(() => {});
  }, [clinicId]);
  // a simulated call ends on its own page too: the bar goes once the call is no longer live
  const live = useQuery({
    queryKey: ['live', clinicId, 'test-call-bar'],
    queryFn: () => api<LiveCalls>(`/clinics/${clinicId}/live`),
    enabled: !!simulated,
    refetchInterval: 5_000,
  });
  useEffect(() => {
    if (!simulated || !live.data || live.dataUpdatedAt < simulated.startedAt) return;
    const there = live.data.calls.some((c) => c.callId === simulated.callId);
    if (there && !simulated.seen) setSimulated({ ...simulated, seen: true });
    // gone once seen, or never there after a while: it has ended
    else if (!there && (simulated.seen || Date.now() - simulated.startedAt > 20_000)) { simulatedId.current = null; setSimulated(null); }
  }, [live.data, live.dataUpdatedAt, simulated]);

  const hangUp = useRef(() => {});
  hangUp.current = () => {
    if (attempt.current) release(attempt.current);
    endSimulated(true);
  };
  const hangUpNow = useCallback(() => hangUp.current(), []);

  // Closing or reloading the tab ends a browser call (navigating inside the app keeps it).
  // A simulated call runs on the server, needs no microphone, and is left to its own page.
  useEffect(() => {
    const leave = () => { if (attempt.current) release(attempt.current); };
    window.addEventListener('pagehide', leave);
    return () => window.removeEventListener('pagehide', leave);
  }, [release]);
  // another clinic, or this frame going away (sign-out): everything ends, through the
  // clinic it was started in (these callbacks change only with the clinic)
  useEffect(() => () => {
    if (attempt.current) release(attempt.current);
    if (recorder.current) { void recorder.current.stop(); recorder.current = null; }
    endSimulated(true);
    setPhase('idle'); setCallId(null); setCaptions([]); setSeconds(0); setMicStopped(false); setMicNote(null); setMuted(false);
  }, [release, endSimulated]);

  const value: TestCallState = {
    clinicId, phase, captions, callId, seconds, maxSeconds, micNote, micStopped, muted, simulated,
    start, end, toggleMute, dismiss: () => setMicStopped(false), startSimulated, endSimulated: () => endSimulated(), hangUpNow,
    record, setRecord, recording, saved,
  };

  return (
    <TestCallContext.Provider value={value}>
      {children}
      <audio ref={audio} autoPlay className="hidden" />
    </TestCallContext.Provider>
  );
}
