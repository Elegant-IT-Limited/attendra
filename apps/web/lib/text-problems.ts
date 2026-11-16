// SPDX-License-Identifier: AGPL-3.0-only
import type { TextProblems } from '@attendra/api/contracts';
import { requestNumber, requestTextLine, taskType } from './format';

/**
 * Texts about requests that were not sent (note 2026-11-16, demo findings 3: a refill's "ready to pick up" text failed
 * a few seconds after the panel closed, and nobody saw it). The words are the request history's own.
 */
export type TextProblem = TextProblems['problems'][number];

/** "R-37 · Prescription refill: Text not sent: the carrier refused it (error 30006)". */
export const problemLine = (p: TextProblem, patientWord: string) => `${requestNumber(p.number)} · ${taskType(p.type, patientWord)}: ${requestTextLine(p)}`;

/** Where the request opens: in the Done list when it is closed. */
export const problemHref = (clinicId: string, p: Pick<TextProblem, 'taskId' | 'taskStatus'>) =>
  `/c/${clinicId}/requests?${p.taskStatus === 'done' ? 'status=done&' : ''}open=${p.taskId}`;

/** The texts this browser has already shown the notice for, per clinic. Storage may be off: then once per page load. */
const key = (clinicId: string) => `attendra.textProblemsSeen.${clinicId}`;
const memory = new Map<string, Set<string>>();
export function seenProblems(clinicId: string): Set<string> {
  const mine = memory.get(clinicId) ?? new Set<string>();
  try { for (const id of JSON.parse(localStorage.getItem(key(clinicId)) ?? '[]') as string[]) mine.add(id); } catch { /* storage off */ }
  memory.set(clinicId, mine);
  return mine;
}
export function markProblemsSeen(clinicId: string, ids: string[]) {
  const mine = seenProblems(clinicId);
  for (const id of ids) mine.add(id);
  // only the last 200: the list looks back three days
  try { localStorage.setItem(key(clinicId), JSON.stringify([...mine].slice(-200))); } catch { /* storage off */ }
}
/** The problems not yet shown in this browser, oldest first. */
export const unseen = (problems: TextProblem[], seen: Set<string>) => problems.filter((p) => !seen.has(p.textId)).sort((a, b) => a.at.localeCompare(b.at));
