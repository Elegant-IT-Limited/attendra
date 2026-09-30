import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../..');

describe('pnpm demo', () => {
  it('passes through turbo every variable the demo server reads', () => {
    const turbo = JSON.parse(readFileSync(join(ROOT, 'turbo.json'), 'utf8')) as { tasks: { demo: { passThroughEnv: string[] } } };
    const server = readFileSync(join(ROOT, 'apps/api/scripts/demo-server.ts'), 'utf8');
    // what it reads from process.env, and the keys it copies in from .env
    const read = new Set([...server.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]!));
    for (const m of server.matchAll(/'([A-Z][A-Z_]+)'/g)) if (/MODEL|KEY|SECONDS/.test(m[1]!)) read.add(m[1]!);
    expect([...read].filter((name) => !turbo.tasks.demo.passThroughEnv.includes(name))).toEqual([]);
  });
});
