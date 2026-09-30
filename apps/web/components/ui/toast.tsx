// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { CheckCircle2, X, XCircle } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

interface Toast { id: number; tone: 'success' | 'error'; message: string; action?: { label: string; onClick: () => void } }
type Show = (t: Omit<Toast, 'id'>) => void;

const ToastContext = createContext<Show>(() => {});

/** "Claimed. Undo": what just happened, said in a live region, with a way back where one makes sense. */
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  const show = useCallback<Show>((t) => {
    const id = ++next.current;
    setToasts((all) => [...all.slice(-2), { ...t, id }]);
    // errors stay until read; a success with an undo stays long enough to use it
    if (t.tone === 'success') setTimeout(() => dismiss(id), t.action ? 8000 : 4000);
  }, [dismiss]);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4 max-md:bottom-20 md:right-4 md:left-auto md:items-end" aria-live="polite" role="status">
        {toasts.map((t) => (
          <div key={t.id} className={cn('pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-md border bg-surface-raised px-4 py-3 text-base shadow-lg animate-rise-in',
            t.tone === 'error' ? 'border-danger/40' : 'border-border')}>
            {t.tone === 'success' ? <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden /> : <XCircle className="size-4 shrink-0 text-danger" aria-hidden />}
            <p className="flex-1">{t.message}</p>
            {t.action && (
              <button type="button" className="focus-ring rounded-sm px-1 font-medium text-primary hover:underline" onClick={() => { t.action!.onClick(); dismiss(t.id); }}>{t.action.label}</button>
            )}
            <button type="button" aria-label="Dismiss" className="focus-ring rounded-sm p-0.5 text-text-muted hover:text-text" onClick={() => dismiss(t.id)}><X className="size-4" /></button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
