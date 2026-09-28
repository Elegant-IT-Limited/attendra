// SPDX-License-Identifier: AGPL-3.0-only
import type { ToolName } from '@attendra/core';
import type { Planner, PlannerInput, PlannerOutput } from './planner';
import type { ToolResult } from './tools';

export interface ScriptedStep { tool: ToolName; args: Record<string, unknown> | ((results: ToolResult[]) => Record<string, unknown>) }

/**
 * A planner that follows a script instead of a model. Tests and evals use it to ask
 * "whatever the model decides, do the rules hold?": the script can deliberately do
 * the wrong thing (book without a yes, skip verification) and runTool must refuse.
 */
export class ScriptedPlanner implements Planner {
  readonly results: ToolResult[] = [];
  constructor(private readonly steps: ScriptedStep[], private readonly say: (results: ToolResult[]) => string | null = defaultSay) {}

  async plan(_input: PlannerInput, execute: (name: ToolName, args: unknown) => Promise<ToolResult>): Promise<PlannerOutput> {
    for (const step of this.steps) {
      const args = typeof step.args === 'function' ? step.args(this.results) : step.args;
      this.results.push(await execute(step.tool, args));
    }
    return { say: this.say(this.results) };
  }
}

function defaultSay(results: ToolResult[]): string | null {
  const last = results.at(-1);
  if (!last) return null;
  return typeof last.data.say === 'string' ? last.data.say : JSON.stringify(last.data);
}
