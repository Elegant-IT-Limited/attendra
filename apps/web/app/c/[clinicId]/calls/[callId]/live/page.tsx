// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, Bot, Check, Hand, Loader2, MessageSquareText, PhoneOff, User, X } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RadioGroup } from '@/components/ui/controls';
import { Panel } from '@/components/ui/dialog';
import { Alert, Empty, Skeleton } from '@/components/ui/feedback';
import { Input, Textarea } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { countryCopy } from '@attendra/core';
import { api, ApiFailure, newKey, useClinic, useClinicConfig } from '@/lib/api';
import { clock, REFUSALS, TOOLS } from '@/lib/format';
import { useLiveCalls } from '@/lib/live';
import { cn } from '@/lib/utils';

type Caption = { speaker: 'caller' | 'agent'; text: string };
type Step =
  | { kind?: 'tool'; tool: string; status: 'started' | 'ok' | 'refused'; code: string | null; at: number }
  // a staff action, with the note's words: from the live stream only, never stored
  | { kind: 'staff'; action: string; by: string | null; note: string | null; at: number };
type Snapshot = { channel: 'phone' | 'web'; startedAt: string; verified: string | null; doing: string | null; pending: string | null; emergency: boolean };

/** Everything the page knows about the call, built from the stream. */
function useLiveCall(clinicId: string, callId: string, onEnded: () => void) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [state, setState] = useState<{ verified: string | null; pending: string | null; doing: string | null }>({ verified: null, pending: null, doing: null });
  const [emergency, setEmergency] = useState<string | null>(null);
  const [staff, setStaff] = useState<string | null>(null);
  const [lost, setLost] = useState(false);
  const ended = useRef(onEnded);
  ended.current = onEnded;

  useEffect(() => {
    // EventSource reconnects on its own and sends Last-Event-ID, so a dropped
    // connection resumes where it stopped
    const source = new EventSource(`/api/v1/clinics/${clinicId}/calls/${callId}/live`);
    const on = (type: string, fn: (data: Record<string, unknown>) => void) => source.addEventListener(type, (e) => fn(JSON.parse((e as MessageEvent).data)));
    on('snapshot', (d) => {
      const s = d.state as Snapshot;
      setSnapshot(s);
      setState({ verified: s.verified, pending: s.pending, doing: s.doing });
      if (s.emergency) setEmergency((e) => e ?? 'emergency');
      setLost(false);
    });
    on('caption', (d) => setCaptions((cs) => {
      const speaker = d.speaker as Caption['speaker'];
      const text = String(d.text);
      const last = cs.at(-1);
      if (last && last.speaker === speaker) return [...cs.slice(0, -1), { speaker, text: `${last.text}${text.startsWith(' ') || last.text.endsWith(' ') ? '' : ' '}${text}`.replace(/\s+/g, ' ') }];
      return [...cs, { speaker, text: text.trim() }];
    }));
    on('tool', (d) => setSteps((ss) => {
      const step = { tool: String(d.tool), status: d.status as 'started' | 'ok' | 'refused', code: (d.code as string | null) ?? null, at: Date.now() };
      // a finished step replaces the one that started it
      const open = step.status !== 'started' ? ss.findLastIndex((s) => s.kind !== 'staff' && s.tool === step.tool && s.status === 'started') : -1;
      return open >= 0 ? ss.map((s, i) => (i === open ? step : s)) : [...ss, step];
    }));
    on('state', (d) => setState({ verified: (d.verified as string | null) ?? null, pending: (d.pending as string | null) ?? null, doing: (d.doing as string | null) ?? null }));
    on('emergency', (d) => setEmergency(String(d.kind)));
    on('staff', (d) => {
      setStaff(String(d.action));
      if (['coached', 'taken_over', 'ended'].includes(String(d.action))) {
        setSteps((ss) => [...ss, { kind: 'staff', action: String(d.action), by: (d.by as string | null) ?? null, note: (d.note as string | undefined) ?? null, at: Date.now() }]);
      }
    });
    on('ended', () => { source.close(); ended.current(); });
    source.onerror = () => { if (source.readyState === EventSource.CLOSED) setLost(true); };
    return () => source.close();
  }, [clinicId, callId]);

  return { snapshot, captions, steps, state, emergency, staff, lost };
}

/** Captions that follow the conversation, unless the reader has scrolled up to read something. */
function Captions({ captions }: { captions: Caption[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  useEffect(() => { if (!paused && box.current) box.current.scrollTop = box.current.scrollHeight; }, [captions, paused]);
  const onScroll = () => {
    const el = box.current;
    if (el) setPaused(el.scrollHeight - el.scrollTop - el.clientHeight > 48);
  };
  return (
    <div className="relative">
      {/* focusable, so the captions can be scrolled from the keyboard too */}
      <div ref={box} onScroll={onScroll} tabIndex={0} className="focus-ring h-[28rem] space-y-4 overflow-y-auto px-5 py-4 max-md:h-[22rem]" aria-live="polite" aria-label="Live captions" role="log">
        {captions.length === 0 && <p className="text-sm text-text-muted">Waiting for someone to speak.</p>}
        {captions.map((c, i) => {
          const agent = c.speaker === 'agent';
          return (
            <div key={i} className={cn('flex gap-3', !agent && 'flex-row-reverse')}>
              <div className={cn('flex size-8 shrink-0 items-center justify-center rounded-full', agent ? 'bg-primary-soft text-primary' : 'bg-surface-sunken text-text-muted')}>
                {agent ? <Bot className="size-4" aria-hidden /> : <User className="size-4" aria-hidden />}
              </div>
              <div className={cn('max-w-[80%] space-y-1', !agent && 'text-right')}>
                <p className="text-xs text-text-muted">{agent ? 'Assistant' : 'Caller'}</p>
                <p className={cn('inline-block rounded-lg px-3.5 py-2 text-left text-sm leading-relaxed', agent ? 'bg-surface-sunken' : 'bg-primary text-on-primary')}>{c.text}</p>
              </div>
            </div>
          );
        })}
      </div>
      {paused && (
        <Button size="sm" variant="outline" className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-lg" onClick={() => setPaused(false)}>
          <ArrowDown /> Jump to the latest
        </Button>
      )}
    </div>
  );
}

function useTicking(startedAt: string | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  return startedAt ? clock(Math.max(0, now - Date.parse(startedAt))) : '0:00';
}

/** "Note from Jordan (front desk)", "Jordan (front desk) ended the call". */
function staffLine(action: string, by: string | null) {
  const who = by ?? 'Someone on the team';
  if (action === 'coached') return `Note from ${by ?? 'the team'}`;
  if (action === 'taken_over') return `${who} took over the call`;
  return `${who} ended the call`;
}

const TAKEN = (e: unknown) => (e instanceof ApiFailure && e.status === 409 && e.body.error === 'already_taken'
  ? `Someone already took this call${(e.body as { by?: string | null }).by ? `: ${(e.body as { by?: string | null }).by}` : ''}.` : null);

export default function LiveCallPage() {
  const { clinicId, callId } = useParams<{ clinicId: string; callId: string }>();
  const router = useRouter();
  const queries = useQueryClient();
  const toast = useToast();
  const { can } = useClinic(clinicId);
  const config = useClinicConfig(clinicId);
  const example = countryCopy({ phoneNumbers: config.data?.phoneNumbers ?? [] }).phone;
  const list = useLiveCalls(clinicId, true, 10_000);
  const listed = list.data?.calls.find((c) => c.callId === callId);
  // when the call ends the page becomes its record, without a reload
  // the record starts looking for its summary at once: nothing cached from before the end is kept
  const toRecord = () => {
    void queries.invalidateQueries({ queryKey: ['calls', clinicId] });
    queries.removeQueries({ queryKey: ['call', clinicId, callId] });
    router.replace(`/c/${clinicId}/calls/${callId}`);
  };
  const live = useLiveCall(clinicId, callId, toRecord);
  // a stream that closed for good, for a call no longer live here, ended while the page could not hear it
  const gone = live.lost && list.isSuccess && !listed;
  useEffect(() => { if (gone) toRecord(); }, [gone]);
  const length = useTicking(live.snapshot?.startedAt ?? listed?.startedAt);
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState<'take' | 'end' | null>(null);
  const [target, setTarget] = useState<'front_desk' | 'me'>('front_desk');
  const [number, setNumber] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const mine = useQuery({ queryKey: ['my-number', clinicId], queryFn: () => api<{ number: string | null }>(`/clinics/${clinicId}/my-transfer-number`), enabled: can('calls:coach') });

  // one key per click: a retried request is the same action, a new click is a new one
  const coach = useMutation({
    mutationFn: (text: string) => api<void>(`/clinics/${clinicId}/calls/${callId}/live/coach`, { method: 'POST', body: JSON.stringify({ note: text, key: newKey() }) }),
    onSuccess: () => { setNote(''); toast({ tone: 'success', message: 'Note sent to the assistant.' }); },
    onError: (e) => setProblem(e instanceof ApiFailure && e.status === 404 ? 'The call has ended.' : 'The note did not reach the assistant. Try again.'),
  });
  const saveNumber = useMutation({
    mutationFn: (n: string) => api<{ number: string }>(`/clinics/${clinicId}/my-transfer-number`, { method: 'PUT', body: JSON.stringify({ number: n }) }),
    onSuccess: () => { void mine.refetch(); setNumber(''); },
  });
  const act = useMutation({
    mutationFn: (kind: 'take' | 'end') => api<void>(`/clinics/${clinicId}/calls/${callId}/live/${kind === 'take' ? 'take-over' : 'end'}`, {
      method: 'POST', body: JSON.stringify(kind === 'take' ? { target, key: newKey() } : { key: newKey() }),
    }),
    onMutate: () => setProblem(null),
    onSuccess: (_d, kind) => { setConfirm(null); toast({ tone: 'success', message: kind === 'take' ? 'Transferring the call to you.' : 'Ending the call.' }); },
    onError: (e) => {
      setConfirm(null);
      const code = e instanceof ApiFailure ? e.body.error : null;
      setProblem(TAKEN(e) ?? (code === 'no_number' ? 'Add your number first.'
        : code === 'emergency_script' ? 'The assistant is still giving the emergency number. You can end the call once the caller has heard it.' : 'That did not work. Try again.'));
    },
  });

  if (!can('calls:read') && list.isSuccess) return <Empty title="Not available">Your role cannot watch live calls, because they show what patients say.</Empty>;
  if (live.lost && !live.snapshot) {
    return <Empty title="This call is not live" action={<Link href={`/c/${clinicId}/calls/${callId}`} className="text-sm text-primary hover:underline">Open the call record</Link>}>It may have ended a moment ago.</Empty>;
  }
  if (!live.snapshot) return <><Skeleton className="h-8 w-72" /><Skeleton className="mt-6 h-96" /></>;

  const web = live.snapshot.channel === 'web';
  const acting = can('calls:coach');
  const handedOff = live.staff === 'taken_over' || live.staff === 'ended';

  return (
    <>
      <Link href={`/c/${clinicId}/calls`} className="mb-4 inline-flex items-center gap-1 text-sm text-text-muted hover:text-text"><ArrowLeft className="size-4" /> All calls</Link>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-2">
          <h1 className="flex items-center gap-2.5 text-xl font-semibold tracking-tight">
            <span className="relative flex size-2.5" aria-hidden><span className="absolute inline-flex size-full rounded-full bg-danger animate-live" /><span className="relative inline-flex size-2.5 rounded-full bg-danger" /></span>
            Live call <span className="font-mono text-lg tabular-nums text-text-muted">{length}</span>
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-text-muted">
            <Badge tone={live.state.verified ? 'ok' : 'neutral'}>{live.state.verified ? `Verified: ${live.state.verified}` : 'Not verified yet'}</Badge>
            {web && <Badge tone="accent">Browser test</Badge>}
            <span>{live.state.pending ? 'Waiting for a yes' : live.state.doing ? `${live.state.doing[0]!.toUpperCase()}${live.state.doing.slice(1)}` : 'Talking'}</span>
          </div>
        </div>
        {acting && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={web || handedOff} title={web ? 'A browser test call cannot be transferred.' : undefined} onClick={() => setConfirm('take')}><Hand /> Take over</Button>
            <Button variant="danger" disabled={handedOff} onClick={() => setConfirm('end')}><PhoneOff /> End call</Button>
          </div>
        )}
      </div>
      {web && acting && <p className="-mt-4 mb-6 text-xs text-text-muted">A browser test call cannot be transferred, so Take over is off here.</p>}
      {live.emergency && (
        <Alert tone="danger" title="Emergency language on this call" className="mb-6">
          The assistant stopped and gave the emergency script. {live.snapshot.channel === 'phone' ? 'Take over if the caller needs a person now.' : ''}
        </Alert>
      )}
      {problem && <Alert tone="warn" className="mb-6">{problem}</Alert>}
      {live.staff === 'transfer_failed' && <Alert tone="warn" className="mb-6" title="The transfer did not go through">The caller is still with the assistant, which is offering a callback. You can try again.</Alert>}
      {live.staff === 'end_failed' && <Alert tone="warn" className="mb-6" title="The call did not end">The caller is still with the assistant, which is offering a callback. You can try again.</Alert>}
      {handedOff && <Alert className="mb-6">{live.staff === 'taken_over' ? 'The call is being transferred to a member of the team.' : 'The assistant is saying goodbye and ending the call.'}</Alert>}
      {live.lost && <Alert tone="warn" className="mb-6">The live connection dropped. Reload the page to reconnect.</Alert>}

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          {live.state.pending && (
            <div className="rounded-lg border border-warning/40 bg-warning-soft px-5 py-4" data-testid="pending-readback">
              <p className="text-xs font-medium uppercase tracking-wide text-text-muted">Waiting for a clear yes to</p>
              <p className="mt-1 text-md font-medium">{live.state.pending}</p>
            </div>
          )}
          <Card>
            <CardHeader><CardTitle>Captions</CardTitle></CardHeader>
            <Captions captions={live.captions} />
          </Card>
          {acting && (
            <Card>
              <CardHeader><CardTitle>Coach the assistant</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-text-muted">A short note only the assistant sees, such as &quot;offer Thursday afternoon&quot;. It never changes the rules: identity, read-back and a clear yes still apply.</p>
                <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (note.trim()) coach.mutate(note.trim()); }}>
                  <Textarea aria-label="Note for the assistant" value={note} maxLength={300} rows={2} onChange={(e) => setNote(e.target.value)} disabled={handedOff} />
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-text-muted">{note.length}/300</span>
                    <Button type="submit" size="sm" loading={coach.isPending} disabled={!note.trim() || handedOff}><MessageSquareText /> Send note</Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          )}
        </div>
        <Card>
          <CardHeader><CardTitle>What the assistant is doing</CardTitle></CardHeader>
          <CardContent>
            {live.steps.length === 0 ? <p className="text-sm text-text-muted">No tools used yet.</p> : (
              <ol className="space-y-3" aria-label="Tool steps">
                {live.steps.map((s, i) => s.kind === 'staff' ? (
                  <li key={i} className="flex gap-3 text-sm" data-testid="staff-step">
                    <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary"><Hand className="size-3" /></span>
                    <div className="min-w-0">
                      <p className="font-medium">{staffLine(s.action, s.by)}</p>
                      {s.note && <p className="break-words text-xs text-text-muted">&ldquo;{s.note}&rdquo;</p>}
                    </div>
                  </li>
                ) : (
                  <li key={i} className="flex gap-3 text-sm">
                    <span className={cn('mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full', s.status === 'refused' ? 'bg-warning-soft' : s.status === 'ok' ? 'bg-success-soft' : 'bg-surface-sunken')}>
                      {s.status === 'started' ? <Loader2 className="size-3 animate-spin" /> : s.status === 'ok' ? <Check className="size-3" /> : <X className="size-3" />}
                    </span>
                    <div>
                      <p className="font-medium">{TOOLS[s.tool] ?? s.tool}</p>
                      <p className="text-xs text-text-muted">{s.status === 'started' ? 'working' : s.code ? (REFUSALS[s.code] ?? s.code) : 'done'}</p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>

      <Panel open={confirm === 'take'} onOpenChange={(o) => setConfirm(o ? 'take' : null)} title="Take over this call?"
        description="The assistant tells the caller a member of the team is coming on, then transfers the call."
        footer={<><Button variant="outline" onClick={() => setConfirm(null)}>Cancel</Button><Button loading={act.isPending} disabled={target === 'me' && !mine.data?.number} onClick={() => act.mutate('take')}>Transfer the call</Button></>}>
        <div className="space-y-4">
          <RadioGroup label="Transfer to" value={target} onValueChange={setTarget} options={[
            { value: 'front_desk', label: 'The front desk line', hint: 'The number in Settings, under Routing.' },
            { value: 'me', label: 'My own number', hint: mine.data?.number ?? 'Not set yet.' },
          ]} />
          {target === 'me' && !mine.data?.number && (
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); saveNumber.mutate(number.trim()); }}>
              <Input aria-label="Your number" placeholder={example.e164} value={number} onChange={(e) => setNumber(e.target.value)} className="flex-1" />
              <Button type="submit" variant="outline" loading={saveNumber.isPending}>Save</Button>
            </form>
          )}
          {saveNumber.isError && <p className="text-sm text-danger">Give the full number with the country code, like {example.e164}. It must be in the clinic's country.</p>}
        </div>
      </Panel>
      <Panel open={confirm === 'end'} onOpenChange={(o) => setConfirm(o ? 'end' : null)} title="End this call?"
        description="The assistant says goodbye to the caller, then hangs up."
        footer={<><Button variant="outline" onClick={() => setConfirm(null)}>Cancel</Button><Button variant="danger" loading={act.isPending} onClick={() => act.mutate('end')}>End the call</Button></>}>
        <p className="text-sm text-text-muted">Anything waiting for a yes is dropped. Nothing is booked.</p>
      </Panel>
    </>
  );
}
