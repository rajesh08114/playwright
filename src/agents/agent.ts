import { ApplicationTarget, AgentResult, AgentTask, Policy, TestCase, TestExecution, TestRun, TestPlan } from "../core/contracts.js";
import { BrowserPool, executeCaseWithRetry } from "../browser-runtime/runner.js";
import { classifyFailures } from "../verification/verifier.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/**
 * A specialist is a scoped, deterministic executor: it owns a set of test categories and runs only those cases.
 * No model calls are made here; see src/llm/provider.ts for the (disabled by default) model interface.
 */
export interface AgentDefinition { name: string; categories: TestCase["category"][]; description: string; }
export interface AgentContext {
  target: ApplicationTarget;
  artifactsDir: string;
  retryBudget: number;
  policy?: Partial<Policy>;
  /** Called after each execution, e.g. to persist it. */
  onExecution?: (execution: TestExecution) => Promise<void>;
  shouldCancel?: () => Promise<boolean>;
}
export const functionalAgent: AgentDefinition = { name: "functional", categories: ["functional"], description: "Validates route availability, headings, console errors, and failed requests." };
export const uiAgent: AgentDefinition = { name: "ui-responsive", categories: ["ui", "responsive"], description: "Checks approved visual baselines and viewport geometry." };
export const accessibilityAgent: AgentDefinition = { name: "accessibility", categories: ["accessibility"], description: "Runs axe-core and fails on violations at or above the policy threshold." };

export async function runAgent(definition: AgentDefinition, cases: TestCase[], context: AgentContext): Promise<{ task: AgentTask; executions: TestExecution[]; result: AgentResult }> {
  const scoped = cases.filter(item => definition.categories.includes(item.category));
  const task: AgentTask = { id: randomUUID(), runId: "agent-local", agent: definition.name, status: "running", budgetMs: Math.max(...scoped.map(item => item.timeoutMs), 1), input: { category: definition.categories, caseCount: scoped.length } };
  const executions: TestExecution[] = [];
  const pool = new BrowserPool(context.target);
  try {
    const profiles = context.target.viewportProfiles.length ? context.target.viewportProfiles : [{ name: "default", width: context.target.viewport.width, height: context.target.viewport.height }];
    for (const testCase of scoped) for (const profile of profiles) {
      if (await context.shouldCancel?.()) { task.status = "cancelled"; return { task, executions, result: { taskId: task.id, status: "cancelled", observations: [`${definition.name} cancelled after ${executions.length} execution(s)`], evidence: executions.flatMap(item => item.evidence) } }; }
      const target = { ...context.target, viewport: { width: profile.width, height: profile.height }, viewportProfileName: profile.name };
      const execution = await executeCaseWithRetry(target, testCase, join(context.artifactsDir, profile.name, testCase.id), context.retryBudget, { browser: await pool.acquire(), policy: context.policy });
      executions.push(execution);
      await context.onExecution?.(execution);
    }
    task.status = "completed";
    return { task, executions, result: { taskId: task.id, status: "completed", observations: [`${definition.name} executed ${executions.length} case(s)`], evidence: executions.flatMap(item => item.evidence) } };
  } catch (error) {
    task.status = "failed";
    return { task, executions, result: { taskId: task.id, status: "failed", observations: [], evidence: executions.flatMap(item => item.evidence), error: error instanceof Error ? error.message : String(error) } };
  } finally { await pool.close(); }
}

export function verifyAgent(run: TestRun, plan: TestPlan) { return { name: "verification", description: "Independent failure classification", findings: classifyFailures(run, plan) }; }
