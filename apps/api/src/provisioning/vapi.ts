// SPDX-License-Identifier: AGPL-3.0-only
import { ClinicConfig, OPENAI_ENGINES, type OpenAiEngine, type VapiLink, type VapiVoiceChoice } from '@attendra/core';
import { type Database, type FrontDeskRepository, type PhiCipher, saveVapiSecret, schema, vapiSecretOf } from '@attendra/db';
import type { Alerter, Logger } from '@attendra/observability';
import { type VapiClient, VapiError, vapiAssistant, vapiAssistantHash, vapiPhoneNumber, vapiServerUrl, vapiSipUri } from '@attendra/voice-engine';
import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';

/** How this deployment reaches Vapi (VAPI_* in the API's environment). Without a client, the Vapi routes answer 503. */
export interface VapiSetup {
  client: VapiClient | null;
  /** VAPI_SIP_CREDENTIAL_ID: the BYO SIP trunk credential at Vapi for our Twilio Vapi trunk (one for every location). */
  credentialId?: string;
  /** VAPI_SIP_HOST: Vapi's SIP host for that credential's region (sip.vapi.ai; sip.eu.vapi.ai in the EU). */
  sipHost: string;
  /** VAPI_SERVER_URL: the public https address Vapi reaches the voice service's /webhooks/vapi/v1/events at. */
  serverBase: string;
  /** VAPI_MAX_CONCURRENCY: Vapi calls the subscription takes at once. */
  maxConcurrency: number;
  /** How long after a settings save the assistant is updated, so one burst of saves is one update. Defaults to 2 s. */
  syncDelayMs?: number;
}

/** What the hosting layer gets back: ids, never the secret. */
export interface VapiResources { assistantId: string; phoneNumberId: string; sipUri: string; updatedAt: string }

/** A refusal the provisioning controller turns into an HTTP answer. */
export class VapiRefusal extends Error {
  constructor(readonly status: number, readonly code: string, readonly extra: Record<string, unknown> = {}) { super(code); }
}

/**
 * A location's Vapi resources (batch 6): its assistant, built from its settings, and its number as a BYO SIP number on
 * our Twilio Vapi trunk, answered by that assistant. Ids are kept in the clinic's settings (`vapi`, operator-only); the
 * location's own secret, which the assistant sends with every request to our Vapi route, in vapi_secrets.
 *
 * Settings changes reach the assistant on their own: every save through the API marks the location, and a moment later
 * its assistant is updated if what it would be built from changed (the hash of the body). The clinic saves its settings
 * straight to the engine, so the hosting layer never sees a save and could not be the one to resync; `PUT .../vapi` is the
 * manual retry (it always sends the assistant again).
 */
export class VapiLocations {
  private readonly due = new Map<string, NodeJS.Timeout>();
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly db: Database, private readonly cipher: PhiCipher, private readonly desk: FrontDeskRepository, private readonly setup: VapiSetup, private readonly log: Logger, private readonly alerts?: Alerter, private readonly now: () => Date = () => new Date()) {}

  /** Vapi calls the subscription takes at once (VAPI_MAX_CONCURRENCY). */
  get maxConcurrency() { return this.setup.maxConcurrency; }

  /** One thing at a time per location: an automatic update never races a provisioning call. */
  private serial<T>(clinicId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(clinicId) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.chains.set(clinicId, run);
    void run.finally(() => { if (this.chains.get(clinicId) === run) this.chains.delete(clinicId); }).catch(() => {});
    return run;
  }

  private client(): VapiClient {
    if (!this.setup.client) throw new VapiRefusal(503, 'vapi_not_configured');
    return this.setup.client;
  }

  private async clinic(clinicId: string): Promise<ClinicConfig> {
    const stored = await this.desk.settings(clinicId);
    if (!stored) throw new VapiRefusal(404, 'not_found');
    return ClinicConfig.parse(stored);
  }

  /** The number the location's calls come in on: its first number the hosting layer assigned and is still active. */
  private async numberOf(clinic: ClinicConfig, wanted?: string): Promise<string> {
    const active = (await this.db.select({ e164: schema.phoneNumbers.e164 }).from(schema.phoneNumbers)
      .where(and(eq(schema.phoneNumbers.clinicId, clinic.id), eq(schema.phoneNumbers.status, 'active')))).map((r) => r.e164);
    if (wanted) {
      if (!active.includes(wanted)) throw new VapiRefusal(409, 'number_not_assigned');
      return wanted;
    }
    const number = clinic.phoneNumbers.find((n) => active.includes(n)) ?? active[0];
    if (!number) throw new VapiRefusal(409, 'no_number');
    return number;
  }

  /** The location's secret, made the first time: 32 random bytes, kept encrypted and as a keyed hash. */
  private async secretOf(clinicId: string): Promise<string> {
    const kept = await vapiSecretOf(this.db, this.cipher, clinicId);
    if (kept) return kept;
    const secret = randomBytes(32).toString('base64url');
    await saveVapiSecret(this.db, this.cipher, clinicId, secret);
    return secret;
  }

  private body(clinic: ClinicConfig, secret: string) {
    return vapiAssistant(clinic, { serverUrl: vapiServerUrl(this.setup.serverBase, clinic.id), secret });
  }

  /** Vapi's refusal as a 502, said once to the people who run Attendra; what Vapi said stays in the log, never in the answer. */
  private failed(clinicId: string, err: unknown, secret?: string): never {
    if (err instanceof VapiRefusal) throw err;
    const detail = err instanceof VapiError ? (secret ? err.detail.split(secret).join('[secret]') : err.detail) : (err as Error).message;
    const status = err instanceof VapiError ? err.status : null;
    this.log.error({ clinic_id: clinicId, vapi_status: status, detail: detail.slice(0, 300) }, 'vapi: a request failed');
    this.alerts?.alert('vapi_failed', `Vapi refused a request (${status ?? 'no answer'}): the location's assistant may be out of date.`, { clinicId });
    throw new VapiRefusal(502, 'vapi_failed', { vapiStatus: status });
  }

  /**
   * Creates or updates the location's assistant and its number at Vapi (idempotent: the ids in its settings are reused;
   * one deleted in Vapi's dashboard is made again). `voice`: the location's own voice, null for the default, absent to keep it.
   */
  provision(clinicId: string, opts: { voice?: VapiVoiceChoice | null; number?: string } = {}): Promise<VapiResources> {
    return this.serial(clinicId, async () => {
      const client = this.client();
      if (!this.setup.credentialId) throw new VapiRefusal(503, 'vapi_sip_credential_missing');
      const stored = await this.clinic(clinicId);
      const voice = opts.voice === null ? undefined : opts.voice ?? stored.vapi?.voice;
      const clinic = ClinicConfig.parse({ ...stored, vapi: { ...stored.vapi, voice } });
      const number = await this.numberOf(clinic, opts.number);
      const secret = await this.secretOf(clinicId);
      const assistant = this.body(clinic, secret);
      try {
        const assistantId = await this.saveAssistant(client, clinic.vapi?.assistantId, assistant);
        const numberBody = vapiPhoneNumber(clinic, number, assistantId, this.setup.credentialId);
        let phoneNumberId = clinic.vapi?.phoneNumberId;
        if (phoneNumberId) {
          try { await client.updatePhoneNumber(phoneNumberId, { assistantId, number, credentialId: numberBody.credentialId, name: numberBody.name }); }
          catch (err) { if (!(err instanceof VapiError && err.status === 404)) throw err; phoneNumberId = undefined; }
        }
        phoneNumberId ??= (await client.createPhoneNumber(numberBody)).id;
        const link: VapiLink = { ...clinic.vapi, assistantId, phoneNumberId, sipUri: vapiSipUri(number, this.setup.credentialId, this.setup.sipHost), updatedAt: this.now().toISOString(), syncedHash: vapiAssistantHash(assistant), voice };
        await this.saveLink(clinicId, 'clinic.vapi.provisioned', () => link);
        this.log.info({ clinic_id: clinicId, assistant_id: assistantId, phone_number_id: phoneNumberId }, 'provisioning: the location\'s Vapi assistant and number are set');
        return { assistantId, phoneNumberId, sipUri: link.sipUri!, updatedAt: link.updatedAt! };
      } catch (err) {
        this.failed(clinicId, err, secret);
      }
    });
  }

  private async saveAssistant(client: VapiClient, id: string | undefined, body: ReturnType<VapiLocations['body']>): Promise<string> {
    if (id) {
      try { return (await client.updateAssistant(id, body)).id; } catch (err) { if (!(err instanceof VapiError && err.status === 404)) throw err; }
    }
    return (await client.createAssistant(body)).id;
  }

  /** Saves the location's Vapi ids through the settings, audited, keeping everything else as it is now. */
  private async saveLink(clinicId: string, action: string, next: (current: VapiLink | undefined) => VapiLink | undefined) {
    const done = await this.desk.updateSettings(clinicId, 'provisioning', action, clinicId, (current) => {
      const c = ClinicConfig.parse(current);
      return { save: { ...c, vapi: next(c.vapi) }, result: true };
    });
    if (!done) throw new VapiRefusal(404, 'not_found');
  }

  /** Removes the number's resource at Vapi (the assistant stays, for switching again), once the location is back on our engine. */
  removeNumber(clinicId: string): Promise<void> {
    return this.serial(clinicId, async () => {
      const clinic = await this.clinic(clinicId);
      if (clinic.voiceEngine === 'vapi') throw new VapiRefusal(409, 'on_vapi');
      const id = clinic.vapi?.phoneNumberId;
      if (!id) return;
      try { await this.client().deletePhoneNumber(id); } catch (err) { this.failed(clinicId, err); }
      await this.saveLink(clinicId, 'clinic.vapi.number_removed', (v) => ({ ...v, phoneNumberId: undefined, sipUri: undefined }));
      this.log.info({ clinic_id: clinicId }, 'provisioning: the location\'s Vapi number removed');
    });
  }

  /** Where the location stands with Vapi: its ids, and whether its assistant still matches its settings. */
  async status(clinicId: string) {
    const clinic = await this.clinic(clinicId);
    const v = clinic.vapi ?? {};
    const inSync = v.assistantId && v.syncedHash ? vapiAssistantHash(this.body(clinic, '')) === v.syncedHash : null;
    return {
      onVapi: clinic.voiceEngine === 'vapi', assistantId: v.assistantId ?? null, phoneNumberId: v.phoneNumberId ?? null, sipUri: v.sipUri ?? null,
      updatedAt: v.updatedAt ?? null, inSync, overflowEngine: v.overflowEngine ?? null, voice: v.voice ?? null,
    };
  }

  /** A settings save for a location: its assistant is updated a moment later if it has one and it changed. */
  touched(clinicId: string) {
    if (!this.setup.client) return;
    const t = this.due.get(clinicId);
    if (t) clearTimeout(t);
    const timer = setTimeout(() => {
      this.due.delete(clinicId);
      void this.sync(clinicId).catch(() => { /* said by sync */ });
    }, this.setup.syncDelayMs ?? 2000);
    timer.unref?.();
    this.due.set(clinicId, timer);
  }

  /** Updates the assistant from the settings when they changed since the last update. True when it sent one. */
  sync(clinicId: string): Promise<boolean> {
    return this.serial(clinicId, async () => {
      const client = this.setup.client;
      const stored = await this.desk.settings(clinicId);
      if (!client || !stored) return false;
      const clinic = ClinicConfig.parse(stored);
      const id = clinic.vapi?.assistantId;
      if (!id) return false;
      const secret = await this.secretOf(clinicId);
      const assistant = this.body(clinic, secret);
      const hash = vapiAssistantHash(assistant);
      if (hash === clinic.vapi?.syncedHash) return false;
      try {
        const assistantId = await this.saveAssistant(client, id, assistant);
        if (assistantId !== id && clinic.vapi?.phoneNumberId) await client.updatePhoneNumber(clinic.vapi.phoneNumberId, { assistantId });
        await this.saveLink(clinicId, 'clinic.vapi.synced', (v) => ({ ...v, assistantId, updatedAt: this.now().toISOString(), syncedHash: hash }));
        this.log.info({ clinic_id: clinicId, assistant_id: assistantId }, 'vapi: the location\'s assistant updated from its settings');
        return true;
      } catch (err) {
        this.failed(clinicId, err, secret);
      }
    });
  }

  /** Waits for every update already due (tests). */
  async idle() {
    for (const [clinicId, t] of [...this.due]) { clearTimeout(t); this.due.delete(clinicId); void this.sync(clinicId).catch(() => {}); }
    await Promise.allSettled([...this.chains.values()]);
  }

  /** The engine of ours a location had, to answer its overflow while on Vapi and to switch back to. */
  static overflowOf(engine: string | undefined, kept: OpenAiEngine | undefined): OpenAiEngine | undefined {
    return (OPENAI_ENGINES as readonly string[]).includes(engine ?? '') ? engine as OpenAiEngine : kept;
  }
}
