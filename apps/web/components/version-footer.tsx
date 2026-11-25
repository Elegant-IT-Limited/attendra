// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useQuery } from '@tanstack/react-query';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

/** What GET /api/v1/version answers: the release, its build number and commit, and whether the tree had changes. */
export interface BuildInfo { version: string; build: number | null; commit: string; dirty: boolean | null }

/** "v0.9.0 · build 1110 · a70b58d5", with "· dirty" for a build from a tree with changes. */
export const versionLine = (v: BuildInfo) => `v${v.version} · build ${v.build ?? 'unknown'} · ${v.commit}${v.dirty ? ' · dirty' : ''}`;

/**
 * Which build this is, small, at the foot of every page, so nobody tests an old one without knowing (VERSION,
 * 2026-11-26). The API's answer, read once per page load; nothing is shown until it arrives, and a failure says so.
 * `inShell`: the clinic pages' own copy, in their content column above the phone's bottom bar; the root layout's copy
 * stands aside on those pages.
 */
export function VersionFooter({ inShell = false }: { inShell?: boolean }) {
  const path = usePathname();
  const version = useQuery({
    queryKey: ['version'],
    // a plain request: it needs no session, and a failure here is never a reason to leave the page
    queryFn: async () => {
      const res = await fetch('/api/v1/version', { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`version ${res.status}`);
      return await res.json() as BuildInfo;
    },
    staleTime: Infinity, retry: 1, refetchOnWindowFocus: false,
  });
  if (!inShell && path.startsWith('/c/')) return null;
  return (
    <footer className={cn('px-4 py-2 text-center text-xs text-text-muted', inShell && 'md:px-8')}>
      {version.data
        ? <span data-testid="app-version" title={`Attendra ${versionLine(version.data)}`}>{versionLine(version.data)}</span>
        : version.isError ? <span data-testid="app-version">Version unknown: the server did not say.</span> : <span className="invisible" aria-hidden>v</span>}
    </footer>
  );
}
