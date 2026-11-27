// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** What this build is: the release's version, its commit (short), its build number (commits up to it) and whether the tree had changes. */
export interface BuildInfo { version: string; build: number | null; commit: string; dirty: boolean | null }

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** The root package.json's version: one number for the whole release. */
function rootVersion(root: string): string {
  try {
    return (JSON.parse(readFileSync(`${root}/package.json`, 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function git(root: string, ...args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

const set = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

/**
 * A release image is built from a `git archive` (no .git): the deploy passes ATTENDRA_COMMIT, ATTENDRA_BUILD and
 * ATTENDRA_DIRTY, at build time or run time. A checkout (development, the tests) asks git. Neither: "unknown", never
 * a guess. A full commit is shortened to 8 characters.
 */
export function buildInfo(env: Record<string, string | undefined> = process.env, root = ROOT): BuildInfo {
  const commitEnv = set(env.ATTENDRA_COMMIT);
  const buildEnv = set(env.ATTENDRA_BUILD);
  const dirtyEnv = set(env.ATTENDRA_DIRTY);
  const fromGit = !commitEnv ? git(root, 'rev-parse', '--short', 'HEAD') : null;
  const commit = commitEnv ? (/^[0-9a-f]{12,}$/i.test(commitEnv) ? commitEnv.slice(0, 8) : commitEnv) : fromGit ?? 'unknown';
  const count = buildEnv ?? (fromGit ? git(root, 'rev-list', '--count', 'HEAD') : null);
  const build = count && /^\d+$/.test(count) ? Number(count) : null;
  const status = dirtyEnv === undefined && fromGit ? git(root, 'status', '--porcelain') : null;
  const dirty = dirtyEnv !== undefined ? /^(true|1|yes)$/i.test(dirtyEnv) : status === null ? null : status.length > 0;
  return { version: rootVersion(root), build, commit, dirty };
}
