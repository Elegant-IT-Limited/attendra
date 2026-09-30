import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../..');

describe('the documented stdio config', () => {
  it('writes nothing but protocol to stdout, so a desktop client can read it', () => {
    const doc = readFileSync(join(ROOT, 'docs/mcp.md'), 'utf8');
    const block = /"attendra": (\{[\s\S]*?"env"[\s\S]*?\}\s*\})/.exec(doc)?.[1];
    const config = JSON.parse(block!) as { command: string; args: string[] };
    const args = config.args.map((a) => (a === '/path/to/attendra' ? ROOT : a));
    // a key that is refused at once: the bridge exits after its error, which goes to stderr
    const run = spawnSync(config.command, args, { env: { ...process.env, ATTENDRA_MCP_URL: 'http://localhost:1/mcp', ATTENDRA_API_KEY: 'not-a-key' }, encoding: 'utf8', input: '', timeout: 60_000 });
    const lines = run.stdout.split('\n').filter((l) => l.trim());
    expect(lines.filter((l) => { try { JSON.parse(l); return false; } catch { return true; } })).toEqual([]);
    expect(run.stderr).toMatch(/ATTENDRA_API_KEY/);
  }, 90_000);
});
