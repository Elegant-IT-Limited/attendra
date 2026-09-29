// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { Shell } from '@/components/shell';

export default function ClinicLayout({ children }: { children: ReactNode }) {
  const { clinicId } = useParams<{ clinicId: string }>();
  return <Shell clinicId={clinicId}>{children}</Shell>;
}
