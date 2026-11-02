import { RIVERBEND_CLINIC } from '@attendra/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanTitles, createPhiCipher, schema, seedRiverbend } from '../src';
import { openTestDatabase, TEST_DATA_KEY } from '../src/testing';

let t: Awaited<ReturnType<typeof openTestDatabase>>;
beforeAll(async () => {
  t = await openTestDatabase();
  await seedRiverbend(t.db, createPhiCipher(TEST_DATA_KEY));
});
afterAll(() => t.close());

const providers = async () => ((await t.db.select({ config: schema.clinics.config }).from(schema.clinics).where(eq(schema.clinics.id, RIVERBEND_CLINIC.id)))[0]!.config as typeof RIVERBEND_CLINIC).providers;

describe('"Dr." built in: the vets\' title clean-up', () => {
  it('counts on a dry run, strips typed titles and sets one on apply, and is quiet the second time', async () => {
    const before = await providers();
    const typed = before.filter((p) => /^dr\.?\s/i.test(p.name)).length;
    const people = before.filter((p) => p.kind !== 'room' && !p.title).length;
    const dry = await cleanTitles(t.db, { apply: false });
    expect(dry.stripped).toBeGreaterThanOrEqual(typed);
    expect(dry.titled).toBeGreaterThanOrEqual(people);
    expect(await providers()).toEqual(before); // nothing written

    await cleanTitles(t.db, { apply: true });
    const after = await providers();
    for (const p of after) {
      expect(p.name).not.toMatch(/^dr\.?\s/i);
      if (p.kind !== 'room') expect(p.title).toBe('dr');
    }
    expect(await cleanTitles(t.db, { apply: false })).toMatchObject({ settings: 0, stripped: 0, titled: 0 });
  });
});
