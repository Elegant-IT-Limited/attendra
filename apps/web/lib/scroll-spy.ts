// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useEffect, useState } from 'react';

/**
 * Which of these sections is being read: the last one whose top has passed a line
 * near the top of the screen, or the last one when the page is scrolled to the end.
 * Listens in the capture phase, so it works whichever element scrolls.
 */
export function useActiveSection(ids: string[], offset = 120): string | null {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  const key = ids.join('|');
  useEffect(() => {
    const list = key ? key.split('|') : [];
    let frame = 0;
    const update = () => {
      frame = 0;
      const els = list.map((id) => document.getElementById(id)).filter((el): el is HTMLElement => !!el);
      if (!els.length) return;
      const scroller = document.scrollingElement;
      const atEnd = scroller ? scroller.scrollTop + window.innerHeight >= scroller.scrollHeight - 4 : false;
      let current = els[0]!.id;
      for (const el of els) if (el.getBoundingClientRect().top - offset <= 0) current = el.id;
      // the last sections are too short to reach the line: at the end of the page, the last one is being read
      const last = els[els.length - 1]!;
      if (atEnd && last.getBoundingClientRect().top < window.innerHeight) current = last.id;
      setActive(current);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onScroll);
    return () => { window.removeEventListener('scroll', onScroll, { capture: true }); window.removeEventListener('resize', onScroll); if (frame) cancelAnimationFrame(frame); };
  }, [key, offset]);
  return active;
}
