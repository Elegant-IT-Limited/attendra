// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { hasPreview } from '@attendra/core';
import { Loader2, Phone, Play, Square } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Button, buttonStyles } from '@/components/ui/button';

/**
 * Plays the clinic's saved greeting in a voice, so the person choosing hears it first.
 * The audio is made on the server from the saved greeting: change the greeting, save,
 * and the sample follows.
 */
export function VoicePreview({ clinicId, voice }: { clinicId: string; voice: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'playing'>('idle');
  const [problem, setProblem] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const stop = () => { audio.current?.pause(); audio.current = null; setState('idle'); };
  // a different voice stops the one playing
  useEffect(() => stop, [voice]);

  const play = async () => {
    if (state !== 'idle') { stop(); return; }
    setProblem(null);
    setState('loading');
    try {
      const res = await fetch(`/api/v1/clinics/${clinicId}/voice-sample?voice=${encodeURIComponent(voice)}`, { credentials: 'same-origin' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { message?: string };
        throw new Error(body.message ?? 'The sample could not be played right now.');
      }
      const url = URL.createObjectURL(await res.blob());
      const a = new Audio(url);
      audio.current = a;
      a.onended = () => { URL.revokeObjectURL(url); setState('idle'); };
      await a.play();
      setState('playing');
    } catch (err) {
      setProblem((err as Error).message || 'The sample could not be played right now.');
      setState('idle');
    }
  };

  // a voice only the Live model has is heard on a call, not in a preview
  if (!hasPreview(voice)) {
    return (
      <Link href={`/c/${clinicId}/test-call`} className={buttonStyles({ variant: 'outline' })} title="This voice is only on calls, so it has no preview. Save it, then hear it in a test call."><Phone /> Test call</Link>
    );
  }

  return (
    <div className="space-y-1">
      <Button type="button" variant="outline" onClick={() => void play()} aria-label={state === 'playing' ? 'Stop the sample' : `Listen to ${voice}`}>
        {state === 'loading' ? <Loader2 className="animate-spin" /> : state === 'playing' ? <Square /> : <Play />}
        {state === 'playing' ? 'Stop' : 'Listen'}
      </Button>
      {problem && <p className="text-xs text-danger" role="status">{problem}</p>}
    </div>
  );
}
