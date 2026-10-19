// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

interface Toast { id: number; message: string; action?: { label: string; onClick: () => void } }
type ToastInput = { tone: 'success' | 'error'; message: string; action?: Toast['action'] };

/** What did not work, or what to know: said in a dialog in the middle of the screen, read before going on. */
export interface Problem {
  title: string;
  message?: ReactNode;
  /** Each thing to fix, one per line. */
  items?: string[];
  /** 'info' for something done that is worth a look; 'danger' (the default) for something not done. */
  tone?: 'danger' | 'info';
}

/** A question before something that cannot be taken back, or that changes other records. */
export interface Confirmation {
  title: string;
  message?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
}

interface Feedback {
  toast: (t: ToastInput) => void;
  problem: (p: Problem) => void;
  confirm: (c: Confirmation) => Promise<boolean>;
}

const FeedbackContext = createContext<Feedback>({ toast: () => {}, problem: () => {}, confirm: async () => false });

/**
 * The app's one way to tell people what happened, the same on every screen:
 * - done: a short note that slides in at the bottom of the screen, wherever you are scrolled ("Saved."), with Undo where it makes sense;
 * - not done, or something to know: a dialog in the middle of the screen with what to fix (useProblem);
 * - about to do something that cannot be taken back: a dialog that asks first (useConfirm).
 * A message about a field stays next to that field; a note about the page itself (read-only, did not load) stays on the page.
 */
export const useToast = () => useContext(FeedbackContext).toast;
export const useProblem = () => useContext(FeedbackContext).problem;
export const useConfirm = () => useContext(FeedbackContext).confirm;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [asking, setAsking] = useState<(Confirmation & { answer: (yes: boolean) => void }) | null>(null);
  const next = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  const toast = useCallback((t: ToastInput) => {
    // something that did not work is read in a dialog, never in a note that slides away
    if (t.tone === 'error') { setProblem({ title: 'That did not work', message: t.message }); return; }
    const id = ++next.current;
    setToasts((all) => [...all.slice(-2), { id, message: t.message, action: t.action }]);
    setTimeout(() => dismiss(id), t.action ? 8000 : 4000);
  }, [dismiss]);
  const confirm = useCallback((c: Confirmation) => new Promise<boolean>((resolve) => {
    setAsking({ ...c, answer: (yes) => { setAsking(null); resolve(yes); } });
  }), []);
  const value = useRef<Feedback>({ toast, problem: setProblem, confirm });
  value.current.toast = toast;
  value.current.confirm = confirm;

  const ProblemIcon = problem?.tone === 'info' ? Info : AlertTriangle;
  return (
    <FeedbackContext.Provider value={value.current}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4 max-md:bottom-20 md:right-4 md:left-auto md:items-end" aria-live="polite" role="status">
        {toasts.map((t) => (
          <div key={t.id} className="pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-md border border-border bg-surface-raised px-4 py-3 text-base shadow-lg animate-rise-in">
            <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />
            <p className="flex-1">{t.message}</p>
            {t.action && (
              <button type="button" className="focus-ring rounded-sm px-1 font-medium text-primary hover:underline" onClick={() => { t.action!.onClick(); dismiss(t.id); }}>{t.action.label}</button>
            )}
            <button type="button" aria-label="Dismiss" className="focus-ring rounded-sm p-0.5 text-text-muted hover:text-text" onClick={() => dismiss(t.id)}><X className="size-4" /></button>
          </div>
        ))}
      </div>

      <Panel open={!!problem} onOpenChange={(open) => { if (!open) setProblem(null); }} title={problem?.title ?? ''} stacked className="max-w-md"
        footer={<Button autoFocus onClick={() => setProblem(null)}>OK</Button>}>
        {problem && (
          <div className="flex gap-3" role={problem.tone === 'info' ? 'status' : 'alert'}>
            <ProblemIcon className={cn('mt-0.5 size-5 shrink-0', problem.tone === 'info' ? 'text-info' : 'text-danger')} aria-hidden />
            <div className="space-y-2 text-base">
              {problem.message && <div>{problem.message}</div>}
              {!!problem.items?.length && <ul className="list-disc space-y-1 pl-4">{problem.items.map((m, i) => <li key={i}>{m}</li>)}</ul>}
            </div>
          </div>
        )}
      </Panel>

      <Panel open={!!asking} onOpenChange={(open) => { if (!open) asking?.answer(false); }} title={asking?.title ?? ''} stacked className="max-w-md"
        footer={asking && <>
          <Button variant="ghost" onClick={() => asking.answer(false)}>{asking.cancelLabel ?? 'Cancel'}</Button>
          <Button variant={asking.tone === 'danger' ? 'danger' : 'primary'} autoFocus onClick={() => asking.answer(true)}>{asking.confirmLabel}</Button>
        </>}>
        {asking?.message && <div className="text-base">{asking.message}</div>}
      </Panel>
    </FeedbackContext.Provider>
  );
}
