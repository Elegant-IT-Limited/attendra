// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { startApi } from './helpers';

describe('the health check asks the database', () => {
  it('answers 200 with the database up, and 503 with it gone, so the uptime check sees an outage', async () => {
    const api = await startApi({ demoMode: false });
    try {
      const up = await api.request('GET', '/api/v1/health');
      expect(up.statusCode).toBe(200);
      expect(up.json()).toMatchObject({ ok: true, database: 'ok' });
      // the database goes away under a running API
      await api.t.close();
      const down = await api.request('GET', '/api/v1/health');
      expect(down.statusCode).toBe(503);
      expect(down.json()).toEqual({ ok: false, database: 'down' });
    } finally {
      await api.app.close();
    }
  });
});
