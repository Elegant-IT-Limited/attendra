// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { type Database, withClinic } from '../client';
import { type PhiCipher, phiContext } from '../crypto';

export interface Endpoint {
  id: string; url: string; description: string; events: string[]; enabled: boolean; disabledReason: string | null; disabledAt: Date | null;
  consecutiveFailures: number; createdAt: Date; rotating: boolean;
  /** Deliveries leave out patientId: on unless the clinic turned it off for this endpoint. */
  omitPatientIds: boolean;
  lastAttempt: { at: Date; statusCode: number | null; error: string | null } | null;
}
/** Event names are fixed identifiers with no commas; the list travels as one bound parameter. */
export interface StoredEvent { id: string; clinicId: string; type: string; data: Record<string, string | number | boolean | null>; occurredAt: string }
export interface Attempt { id: number; endpointId: string; eventId: string; eventType: string; kind: 'automatic' | 'test' | 'redelivery'; attempt: number; statusCode: number | null; durationMs: number; error: string | null; at: Date }

const SECRET = 'webhook_endpoints.secret';
/** An endpoint that has failed this many events in a row, each after its full day of retries, is turned off. */
export const DISABLE_AFTER = 3;
const rows = <T>(r: { rows: unknown[] }) => r.rows as T[];
const actor = (userId: string) => (userId === 'worker' ? 'worker' : `user:${userId}`);

/**
 * Webhook endpoints, the events sent to them, and every attempt. Endpoint changes are
 * audited; the secret is encrypted at rest and only ever shown once, when it is made.
 */
export class WebhookRepository {
  constructor(private readonly db: Database, private readonly cipher: PhiCipher) {}

  private audit(tx: Parameters<Parameters<typeof withClinic>[2]>[0], clinicId: string, userId: string, action: string, endpointId: string) {
    return tx.execute(sql`insert into audit_logs (clinic_id, actor, action, entity, entity_id) values (${clinicId}, ${actor(userId)}, ${action}, 'webhook_endpoint', ${endpointId})`);
  }

  async create(clinicId: string, e: { url: string; description: string; events: string[]; secret: string; userId: string; omitPatientIds?: boolean }): Promise<string> {
    return withClinic(this.db, clinicId, async (tx) => {
      const [row] = rows<{ id: string }>(await tx.execute(sql`
        insert into webhook_endpoints (clinic_id, url, description, events, secret_enc, created_by_user_id, omit_patient_ids)
        values (${clinicId}, ${e.url}, ${e.description}, string_to_array(${e.events.join(',')}, ','),
          ${this.cipher.encrypt(e.secret, phiContext(clinicId, SECRET))}, ${e.userId}, ${e.omitPatientIds ?? true}) returning id`));
      await this.audit(tx, clinicId, e.userId, 'webhook.endpoint.created', row!.id);
      return row!.id;
    });
  }

  async list(clinicId: string): Promise<Endpoint[]> {
    return withClinic(this.db, clinicId, async (tx) => rows<Record<string, unknown>>(await tx.execute(sql`
      select e.*, a.at as last_at, a.status_code as last_status, a.error as last_error
      from webhook_endpoints e
      left join lateral (select at, status_code, error from webhook_attempts where clinic_id = e.clinic_id and endpoint_id = e.id order by at desc, id desc limit 1) a on true
      where e.clinic_id = ${clinicId} order by e.created_at`)).map(toEndpoint));
  }

  async get(clinicId: string, id: string): Promise<Endpoint | null> {
    return (await this.list(clinicId)).find((e) => e.id === id) ?? null;
  }

  /** The secrets a delivery is signed with: the current one, and the previous one until its grace period ends. */
  async secrets(clinicId: string, id: string, now = new Date()): Promise<{ url: string; enabled: boolean; secrets: string[]; omitPatientIds: boolean } | null> {
    return withClinic(this.db, clinicId, async (tx) => {
      const [r] = rows<{ url: string; enabled: boolean; secret_enc: string; previous_secret_enc: string | null; previous_expires_at: string | null; omit_patient_ids: boolean }>(await tx.execute(sql`
        select url, enabled, secret_enc, previous_secret_enc, previous_expires_at, omit_patient_ids from webhook_endpoints where clinic_id = ${clinicId} and id = ${id}`));
      if (!r) return null;
      const ctx = phiContext(clinicId, SECRET);
      const secrets = [this.cipher.decrypt(r.secret_enc, ctx)];
      if (r.previous_secret_enc && r.previous_expires_at && new Date(r.previous_expires_at) > now) secrets.push(this.cipher.decrypt(r.previous_secret_enc, ctx));
      return { url: r.url, enabled: r.enabled, secrets, omitPatientIds: r.omit_patient_ids };
    });
  }

  /** Changes what an endpoint gets or where it goes. Turning it back on clears its failures. */
  async update(clinicId: string, id: string, patch: { url?: string; description?: string; events?: string[]; enabled?: boolean; omitPatientIds?: boolean }, userId: string): Promise<boolean> {
    return withClinic(this.db, clinicId, async (tx) => {
      const sets = [
        patch.url !== undefined ? sql`url = ${patch.url}` : null,
        patch.description !== undefined ? sql`description = ${patch.description}` : null,
        patch.events !== undefined ? sql`events = string_to_array(${patch.events.join(',')}, ',')` : null,
        patch.enabled === true ? sql`enabled = true, disabled_reason = null, disabled_at = null, consecutive_failures = 0` : null,
        patch.enabled === false ? sql`enabled = false, disabled_reason = 'turned_off', disabled_at = now()` : null,
        patch.omitPatientIds !== undefined ? sql`omit_patient_ids = ${patch.omitPatientIds}` : null,
      ].filter((x) => x !== null);
      if (!sets.length) return true;
      const done = rows<{ id: string }>(await tx.execute(sql`update webhook_endpoints set ${sql.join(sets, sql`, `)}, updated_at = now() where clinic_id = ${clinicId} and id = ${id} returning id`));
      if (!done.length) return false;
      await this.audit(tx, clinicId, userId, 'webhook.endpoint.updated', id);
      return true;
    });
  }

  async remove(clinicId: string, id: string, userId: string): Promise<boolean> {
    return withClinic(this.db, clinicId, async (tx) => {
      const done = rows<{ id: string }>(await tx.execute(sql`delete from webhook_endpoints where clinic_id = ${clinicId} and id = ${id} returning id`));
      if (!done.length) return false;
      await this.audit(tx, clinicId, userId, 'webhook.endpoint.deleted', id);
      return true;
    });
  }

  /** A new secret. The old one keeps signing alongside it for `graceHours`, so a receiver can switch over without dropping anything. */
  async rotate(clinicId: string, id: string, secret: string, userId: string, graceHours = 24): Promise<boolean> {
    return withClinic(this.db, clinicId, async (tx) => {
      const done = rows<{ id: string }>(await tx.execute(sql`update webhook_endpoints set previous_secret_enc = secret_enc,
        previous_expires_at = now() + make_interval(hours => ${graceHours}), secret_enc = ${this.cipher.encrypt(secret, phiContext(clinicId, SECRET))}, updated_at = now()
        where clinic_id = ${clinicId} and id = ${id} returning id`));
      if (!done.length) return false;
      await this.audit(tx, clinicId, userId, 'webhook.endpoint.secret_rotated', id);
      return true;
    });
  }

  /** Stores an event once; the same event again is the same row. */
  async record(e: StoredEvent): Promise<void> {
    await withClinic(this.db, e.clinicId, (tx) => tx.execute(sql`insert into webhook_events (id, clinic_id, type, data, occurred_at)
      values (${e.id}, ${e.clinicId}, ${e.type}, ${JSON.stringify(e.data)}::jsonb, ${e.occurredAt}::timestamptz) on conflict (id) do nothing`));
  }

  async event(clinicId: string, id: string): Promise<StoredEvent | null> {
    return withClinic(this.db, clinicId, async (tx) => {
      const [r] = rows<{ id: string; clinic_id: string; type: string; data: StoredEvent['data']; occurred_at: string | Date }>(await tx.execute(sql`select id, clinic_id, type, data, occurred_at from webhook_events where clinic_id = ${clinicId} and id = ${id}`));
      return r ? { id: r.id, clinicId: r.clinic_id, type: r.type, data: r.data, occurredAt: new Date(r.occurred_at).toISOString() } : null;
    });
  }

  /** The endpoints that want this kind of event, and are on. */
  async subscribers(clinicId: string, type: string): Promise<string[]> {
    return withClinic(this.db, clinicId, async (tx) => rows<{ id: string }>(await tx.execute(sql`select id from webhook_endpoints where clinic_id = ${clinicId} and enabled and ${type} = any(events)`)).map((r) => r.id));
  }

  async logAttempt(clinicId: string, a: Omit<Attempt, 'id' | 'at' | 'eventType'>): Promise<number> {
    return withClinic(this.db, clinicId, async (tx) => {
      const [row] = rows<{ id: number }>(await tx.execute(sql`insert into webhook_attempts (clinic_id, endpoint_id, event_id, kind, attempt, status_code, duration_ms, error)
        values (${clinicId}, ${a.endpointId}, ${a.eventId}, ${a.kind}, ${a.attempt}, ${a.statusCode}, ${a.durationMs}, ${a.error}) returning id`));
      return Number(row!.id);
    });
  }

  async attempts(clinicId: string, endpointId: string, limit = 50): Promise<Attempt[]> {
    return withClinic(this.db, clinicId, async (tx) => rows<Record<string, unknown>>(await tx.execute(sql`
      select a.*, ev.type as event_type from webhook_attempts a join webhook_events ev on ev.id = a.event_id
      where a.clinic_id = ${clinicId} and a.endpoint_id = ${endpointId} order by a.at desc, a.id desc limit ${limit}`)).map(toAttempt));
  }

  async attempt(clinicId: string, id: number): Promise<Attempt | null> {
    return withClinic(this.db, clinicId, async (tx) => {
      const [r] = rows<Record<string, unknown>>(await tx.execute(sql`select a.*, ev.type as event_type from webhook_attempts a join webhook_events ev on ev.id = a.event_id where a.clinic_id = ${clinicId} and a.id = ${id}`));
      return r ? toAttempt(r) : null;
    });
  }

  async delivered(clinicId: string, endpointId: string) {
    await withClinic(this.db, clinicId, (tx) => tx.execute(sql`update webhook_endpoints set consecutive_failures = 0 where clinic_id = ${clinicId} and id = ${endpointId}`));
  }

  /**
   * An event that failed every retry. After DISABLE_AFTER of those in a row the
   * endpoint is turned off, audited, and the dashboard tells the clinic's managers.
   */
  async exhausted(clinicId: string, endpointId: string): Promise<{ disabled: boolean }> {
    return withClinic(this.db, clinicId, async (tx) => {
      const [r] = rows<{ consecutive_failures: number }>(await tx.execute(sql`update webhook_endpoints set consecutive_failures = consecutive_failures + 1
        where clinic_id = ${clinicId} and id = ${endpointId} returning consecutive_failures`));
      if (!r || r.consecutive_failures < DISABLE_AFTER) return { disabled: false };
      const off = rows<{ id: string }>(await tx.execute(sql`update webhook_endpoints set enabled = false, disabled_reason = 'repeated_failures', disabled_at = now()
        where clinic_id = ${clinicId} and id = ${endpointId} and enabled returning id`));
      if (off.length) await this.audit(tx, clinicId, 'worker', 'webhook.endpoint.disabled', endpointId);
      return { disabled: off.length > 0 };
    });
  }
}

function toEndpoint(r: Record<string, unknown>): Endpoint {
  return {
    id: String(r.id), url: String(r.url), description: String(r.description), events: r.events as string[], enabled: !!r.enabled,
    disabledReason: (r.disabled_reason as string | null) ?? null, disabledAt: r.disabled_at ? new Date(r.disabled_at as string) : null,
    consecutiveFailures: Number(r.consecutive_failures), createdAt: new Date(r.created_at as string),
    rotating: !!r.previous_expires_at && new Date(r.previous_expires_at as string) > new Date(),
    omitPatientIds: r.omit_patient_ids !== false,
    lastAttempt: r.last_at ? { at: new Date(r.last_at as string), statusCode: (r.last_status as number | null) ?? null, error: (r.last_error as string | null) ?? null } : null,
  };
}

const toAttempt = (r: Record<string, unknown>): Attempt => ({
  id: Number(r.id), endpointId: String(r.endpoint_id), eventId: String(r.event_id), eventType: String(r.event_type), kind: r.kind as Attempt['kind'],
  attempt: Number(r.attempt), statusCode: (r.status_code as number | null) ?? null, durationMs: Number(r.duration_ms), error: (r.error as string | null) ?? null, at: new Date(r.at as string),
});

/** An appointment's facts for an event: ids, times and status. Nothing about the patient but their id. */
export async function appointmentFacts(db: Database, clinicId: string, id: string) {
  return withClinic(db, clinicId, async (tx) => {
    const [r] = rows<{ id: string; patient_id: string; provider_id: string; visit_type_id: string; starts_at: string | Date; ends_at: string | Date; status: string; created_by_call_id: string | null; cancel_reason: string | null; updated_at: string | Date }>(
      await tx.execute(sql`select id, patient_id, provider_id, visit_type_id, starts_at, ends_at, status, created_by_call_id, cancel_reason, updated_at from appointments where clinic_id = ${clinicId} and id = ${id}`));
    return r ? {
      appointmentId: r.id, patientId: r.patient_id, providerId: r.provider_id, visitTypeId: r.visit_type_id,
      startsAt: new Date(r.starts_at).toISOString(), endsAt: new Date(r.ends_at).toISOString(), status: r.status, cancelReason: r.cancel_reason,
      updatedAt: new Date(r.updated_at).toISOString(),
    } : null;
  });
}

/** A closed call's facts for call.completed: channel, times, outcome, flags. No transcript, no caller. */
export async function callFacts(db: Database, clinicId: string, callId: string) {
  return withClinic(db, clinicId, async (tx) => {
    const [r] = rows<{ channel: string; started_at: string | Date; ended_at: string | Date | null; outcome: string | null; emergency_flag: boolean; voice_seconds: string | null; patient_id: string | null }>(
      await tx.execute(sql`select channel, started_at, ended_at, outcome, emergency_flag, voice_seconds, patient_id from calls where clinic_id = ${clinicId} and id = ${callId}`));
    return r ? {
      callId, channel: r.channel, startedAt: new Date(r.started_at).toISOString(), endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : null,
      durationSeconds: r.voice_seconds === null ? null : Math.round(Number(r.voice_seconds)), outcome: r.outcome, emergency: r.emergency_flag, verified: r.patient_id !== null,
    } : null;
  });
}

/** A request's facts for request.done: its type and how it was closed. */
export async function taskFacts(db: Database, clinicId: string, id: string) {
  return withClinic(db, clinicId, async (tx) => {
    const [r] = rows<{ type: string; outcome: string | null; call_id: string | null }>(await tx.execute(sql`select type, outcome, call_id from tasks where clinic_id = ${clinicId} and id = ${id}`));
    return r ? { requestId: id, type: r.type, outcome: r.outcome, callId: r.call_id } : null;
  });
}
