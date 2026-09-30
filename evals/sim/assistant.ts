// SPDX-License-Identifier: AGPL-3.0-only
import { CallAgent, CallState, type Planner, type ToolResult } from '@attendra/agent';
import { type ClinicConfig, type QualityCall, type ToolName } from '@attendra/core';
import { CallRepository, createPhiCipher, type Database, KnowledgeRepository, PostgresAuditLog, PostgresPatientDirectory, PostgresTaskQueue } from '@attendra/db';
import { TEST_DATA_KEY } from '@attendra/db/testing';
import { HybridKnowledgeBase, LocalEmbedder } from '@attendra/knowledge';
import { createLogger } from '@attendra/observability';
import { BuiltinScheduler } from '@attendra/scheduling';
import { Writable } from 'node:stream';

/**
 * The assistant being tested. As text now: each caller line goes to the real
 * CallAgent, as a transcript and a delegation, and the reply is what the backend
 * would have the voice say. A voice version would run GPT-Live over WebRTC behind
 * this same interface.
 */
export interface AssistantUnderTest {
  readonly greeting: string;
  hear(text: string): Promise<{ reply: string; ended: boolean }>;
  /** The call as the quality numbers count it. */
  result(): QualityCall & { refusedTools: string[] };
}

const quiet = createLogger({ name: 'sim', destination: new Writable({ write: (_c, _e, done) => done() }) });

/** Remembers what each tool returned, so the refusals and the booking attempt can be counted. */
class Watched implements Planner {
  readonly results: { tool: string; result: ToolResult }[] = [];
  constructor(private readonly inner: Planner) {}
  plan(input: Parameters<Planner['plan']>[0], execute: (name: ToolName, args: unknown) => Promise<ToolResult>) {
    return this.inner.plan(input, async (name, args) => { const r = await execute(name, args); this.results.push({ tool: name, result: r }); return r; });
  }
}

export class TextAssistant implements AssistantUnderTest {
  readonly greeting: string;
  private readonly agent: CallAgent;
  private readonly planner: Watched;
  private clock = 0;
  private delegations = 0;
  private callerTurns = 0;
  private ended = false;
  private transferred = false;

  constructor(db: Database, clinic: ClinicConfig, callId: string, callerNumber: string | null, planner: Planner, now: () => Date) {
    const cipher = createPhiCipher(TEST_DATA_KEY);
    this.greeting = clinic.greeting;
    this.planner = new Watched(planner);
    const backend = {
      patients: new PostgresPatientDirectory(db, cipher), scheduler: new BuiltinScheduler(db), tasks: new PostgresTaskQueue(db, cipher),
      audit: new PostgresAuditLog(db), messenger: { sendTemplate: async () => {} }, knowledge: new HybridKnowledgeBase(new KnowledgeRepository(db), new LocalEmbedder()),
    };
    const calls = new CallRepository(db, cipher);
    this.agent = new CallAgent(new CallState(), { clinic, callId, callerNumber, now, log: quiet }, backend, this.planner, quiet, {
      record: (a) => calls.recordAction(clinic.id, callId, { tool: a.tool, argsRedacted: a.argsRedacted, result: a.result, taskRevision: a.revision, patientId: a.patientId }),
    });
    this.agent.onAgentTranscript(clinic.greeting, 0, 1000);
  }

  async hear(text: string) {
    this.clock += 3000;
    this.callerTurns++;
    const heard = this.agent.onCallerTranscript(text, this.clock, this.clock + 1500);
    const script = heard.find((o) => o.type === 'instructions');
    // the emergency script is what the voice says next, word for word
    const quoted = script?.type === 'instructions' ? script.content.match(/"([^"]+)"/)?.[1] : null;
    const out = await this.agent.onDelegation(`sim_${++this.delegations}`);
    const said = out.flatMap((o) => (o.type === 'commentary' ? [o.content] : []));
    if (out.some((o) => o.type === 'transfer') || heard.some((o) => o.type === 'transfer')) { this.transferred = true; this.ended = true; }
    if (out.some((o) => o.type === 'hangup')) this.ended = true;
    const reply = [quoted, ...said].filter(Boolean).join(' ') || 'Let me check that for you.';
    this.clock += 3000;
    this.agent.onAgentTranscript(reply, this.clock, this.clock + 2000);
    return { reply, ended: this.ended };
  }

  result() {
    const state = this.agent.state;
    const refusals = this.planner.results.flatMap((r) => (typeof r.result.data.error === 'string' ? [r.result.data.error] : []));
    return {
      outcome: state.outcome, closeReason: this.transferred ? 'transferred' : 'caller_hangup',
      // text has no audio: count the words a voice would have said, at about 150 a minute
      voiceSeconds: Math.round(state.turns.reduce((n, t) => n + t.text.split(/\s+/).length, 0) / 150 * 60),
      flagged: state.emergency !== null, triedToBook: this.planner.results.some((r) => r.tool === 'propose_booking'),
      callerTurns: this.callerTurns, refusals, afterHours: false, refusedTools: this.planner.results.filter((r) => r.result.data.error).map((r) => r.tool),
    };
  }
}
