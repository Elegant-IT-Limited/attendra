// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useMutation } from '@tanstack/react-query';
import { PlayCircle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert } from '@/components/ui/feedback';
import { api } from '@/lib/api';

/**
 * The local demo can play a scripted call through the real assistant, with no audio
 * and no OpenAI, and open it live: the quickest way to see captions, the tool steps
 * and the staff actions without a phone or a microphone.
 */
export function SimulatedCall({ clinicId }: { clinicId: string }) {
  const router = useRouter();
  const start = useMutation({
    mutationFn: () => api<{ callId: string }>(`/clinics/${clinicId}/test-calls/simulated`, { method: 'POST' }),
    onSuccess: ({ callId }) => router.push(`/c/${clinicId}/calls/${callId}/live`),
  });
  return (
    <Card className="mt-6">
      <CardHeader><CardTitle>Watch a simulated call</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-text-muted">
          A demo patient calls to book a visit, scripted, through the real assistant and this clinic&apos;s calendar. It stops at the read-back and waits, so you can
          watch it live, send the assistant a note, or end it. No audio, and no OpenAI credit.
        </p>
        {start.isError && <Alert tone="danger">The simulated call did not start. Try again.</Alert>}
        <Button variant="outline" loading={start.isPending} onClick={() => start.mutate()}><PlayCircle /> Play a simulated call</Button>
      </CardContent>
    </Card>
  );
}
