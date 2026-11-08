// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLayoutEffect, useRef } from 'react';

/** The browser performance measures the schedule's grids leave, one per render with something to draw (note 29). */
export const RENDER_MARKS = { grid: 'schedule-grid', agenda: 'schedule-agenda' } as const;

/**
 * Times a component's own render with the browser's User Timing marks: from the start of its render (the first one,
 * when React renders twice in development) to just after React has put it on the page, before the browser paints,
 * as one `performance.measure` named `name`. Only renders with something to draw (`ready`) count. It measures the
 * render alone: no network, no server, no page load, so a busy machine's other work barely moves it.
 */
export function useRenderMark(name: string, ready: boolean) {
  const started = useRef(false);
  if (ready && !started.current && typeof performance !== 'undefined') {
    performance.mark(`${name}:start`);
    started.current = true;
  }
  useLayoutEffect(() => {
    if (!started.current) return;
    started.current = false;
    performance.mark(`${name}:end`);
    performance.measure(name, `${name}:start`, `${name}:end`);
  });
}
