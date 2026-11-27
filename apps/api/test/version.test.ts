// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildInfo } from '../src/version';
import { startApi } from './helpers';

const root = new URL('../../../', import.meta.url);
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const version = (JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as { version?: string }).version;

// VERSION (2026-11-26): every build says exactly what it is, so nobody tests an old one. The API answers the root
// package.json's version, the commit, the build number (commits on it) and whether the tree was dirty: from the
// environment a release build sets, else from git in a checkout. No session needed and nothing secret in it.
describe('VERSION: the build says what it is', () => {
  it('VERSION: GET /api/v1/version answers this checkout\'s commit, build number and version, signed out', async () => {
    const api = await startApi({ demoMode: false });
    try {
      const res = await api.request('GET', '/api/v1/version', { origin: null });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { version: string; build: number | null; commit: string; dirty: boolean | null };
      expect(version).toMatch(/^\d+\.\d+\.\d+/);
      expect(body.version).toBe(version);
      expect(body.commit).toBe(git('rev-parse', '--short', 'HEAD'));
      expect(body.build).toBe(Number(git('rev-list', '--count', 'HEAD')));
      expect(body.dirty).toBe(git('status', '--porcelain').length > 0);
      // only these four: no environment, no paths, no keys
      expect(Object.keys(body).sort()).toEqual(['build', 'commit', 'dirty', 'version']);
    } finally {
      await api.app.close();
    }
  });

  it('VERSION: a release build\'s environment wins over git, and a full commit is shortened', () => {
    const sha = 'a70b58d5c0ffee00112233445566778899aabbcc';
    expect(buildInfo({ ATTENDRA_COMMIT: sha, ATTENDRA_BUILD: '1110', ATTENDRA_DIRTY: 'false' })).toMatchObject({ commit: 'a70b58d5', build: 1110, dirty: false });
    expect(buildInfo({ ATTENDRA_COMMIT: 'a70b58d5', ATTENDRA_BUILD: '7', ATTENDRA_DIRTY: 'true' })).toMatchObject({ commit: 'a70b58d5', build: 7, dirty: true });
    // whichever way a deploy writes it
    for (const yes of ['TRUE', 'True', '1', 'yes']) expect(buildInfo({ ATTENDRA_COMMIT: 'a70b58d5', ATTENDRA_DIRTY: yes }).dirty, yes).toBe(true);
    for (const no of ['FALSE', 'False', '0', 'no']) expect(buildInfo({ ATTENDRA_COMMIT: 'a70b58d5', ATTENDRA_DIRTY: no }).dirty, no).toBe(false);
  });

  it('VERSION: with no environment and no git (a git archive), it says unknown rather than guessing', () => {
    expect(buildInfo({}, '/nonexistent-attendra-tree')).toMatchObject({ commit: 'unknown', build: null, dirty: null });
    // an empty value (compose with nothing set) counts as not set
    expect(buildInfo({ ATTENDRA_COMMIT: '', ATTENDRA_BUILD: '', ATTENDRA_DIRTY: '' }, '/nonexistent-attendra-tree')).toMatchObject({ commit: 'unknown', build: null, dirty: null });
  });
});
