// SPDX-License-Identifier: AGPL-3.0-only
import type { TaskList } from '@attendra/api/contracts';

type Call = <T>(path: string, init: RequestInit) => Promise<T>;

/**
 * The Cmd-K palette's request search: open requests and done ones alike (a number is most often looked up for one
 * already closed), in one search, open first. One search is one request and one line in the audit log
 * (RPT-batch-11-07-3-2). `call` is the dashboard's api(), given in so a test can count what is sent.
 */
export async function searchRequests(clinicId: string, q: string, call: Call): Promise<TaskList['tasks']> {
  return (await call<TaskList>(`/clinics/${clinicId}/tasks/search`, { method: 'POST', body: JSON.stringify({ q, status: 'all' }) })).tasks;
}
