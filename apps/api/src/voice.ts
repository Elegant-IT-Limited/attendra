// SPDX-License-Identifier: AGPL-3.0-only
import { TestCall } from './contracts';
import type { LiveActionResult, LiveCallSummary, VoiceClient } from './http/tokens';

/** The voice service's internal routes, authenticated with the token both services share. */
export function httpVoiceClient(baseUrl: string, token: string, timeoutMs = 15_000, capabilities = { browserCalls: true, simulatedCalls: false }): VoiceClient {
  const base = baseUrl.replace(/\/+$/, '');
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const refused = (status: number) => Object.assign(new Error('the voice service refused'), { code: `voice_${status}`, status });
  const headers = { authorization: `Bearer ${token}` };
  const q = (clinicId: string) => `clinicId=${encodeURIComponent(clinicId)}`;
  const action = async (path: string, body: unknown): Promise<LiveActionResult> => {
    const res = await post(path, body);
    if (res.status === 200 || res.status === 202) return { ok: true, repeat: res.status === 200 };
    const b = await res.json().catch(() => ({})) as { error?: string; by?: string };
    return { ok: false, status: res.status, error: b.error ?? `voice_${res.status}`, by: b.by };
  };

  return {
    ...capabilities,
    async startSimulatedCall(clinicId, userId) {
      const res = await post('/internal/simulated-calls', { clinicId, userId });
      if (res.status !== 201) throw refused(res.status);
      return await res.json() as { callId: string };
    },
    async liveCalls(clinicId) {
      const res = await fetch(`${base}/internal/live?${q(clinicId)}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status !== 200) throw refused(res.status);
      return (await res.json() as { calls: LiveCallSummary[] }).calls;
    },
    async liveStream(clinicId, callId, lastEventId, signal) {
      const res = await fetch(`${base}/internal/live/${encodeURIComponent(callId)}?${q(clinicId)}`, { headers: { ...headers, ...(lastEventId ? { 'last-event-id': lastEventId } : {}) }, signal });
      if (res.status === 404) return null;
      if (res.status !== 200 || !res.body) throw refused(res.status);
      return res.body;
    },
    coach: (clinicId, callId, a) => action(`/internal/live/${encodeURIComponent(callId)}/coach`, { clinicId, ...a }),
    takeOver: (clinicId, callId, a) => action(`/internal/live/${encodeURIComponent(callId)}/take-over`, { clinicId, ...a }),
    endCall: (clinicId, callId, a) => action(`/internal/live/${encodeURIComponent(callId)}/end`, { clinicId, ...a }),
    async startTestCall(clinicId, userId, sdp) {
      const res = await post('/internal/web-calls', { clinicId, userId, sdp });
      if (res.status !== 201) throw refused(res.status);
      return TestCall.parse(await res.json());
    },
    async endTestCall(clinicId, callId) {
      const res = await post(`/internal/web-calls/${encodeURIComponent(callId)}/end`, { clinicId });
      if (res.status !== 202) throw refused(res.status);
    },
  };
}
