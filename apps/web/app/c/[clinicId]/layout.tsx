// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { TestCallProvider } from '@/components/calls/test-call';
import { Shell } from '@/components/shell';

export default function ClinicLayout({ children }: { children: ReactNode }) {
  const { clinicId } = useParams<{ clinicId: string }>();
  // the test call outlives the page it started on: it belongs to the clinic, around the frame
  return <TestCallProvider clinicId={clinicId}><Shell clinicId={clinicId}>{children}</Shell></TestCallProvider>;
}
