import { ApplicationTarget, AgentResult, AgentTask, TestCase, TestExecution, TestRun, TestPlan } from "../core/contracts.js";
import { executeCaseWithRetry } from "../browser-runtime/runner.js";
import { classifyFailures } from "../verification/verifier.js";
import { randomUUID } from "node:crypto";

export interface AgentDefinition { name: string; categories: TestCase["category"][]; description: string; }
export interface AgentContext { target: ApplicationTarget; artifactsDir: string; retryBudget: number; }
export const functionalAgent: AgentDefinition = { name: "functional", categories: ["functional"], description: "Validates deterministic functional journeys." };
export const uiAgent: AgentDefinition = { name: "ui-responsive", categories: ["ui", "responsive"], description: "Checks approved visual baselines and viewport geometry." };
export const accessibilityAgent: AgentDefinition = { name: "accessibility", categories: ["accessibility"], description: "Collects axe and semantic accessibility evidence." };

export async function runAgent(definition: AgentDefinition, cases: TestCase[], context: AgentContext): Promise<{ task: AgentTask; executions: TestExecution[]; result: AgentResult }> {
  const task: AgentTask = { id: randomUUID(), runId: "agent-local", agent: definition.name, status: "running", budgetMs: Math.max(...cases.map(item => item.timeoutMs), 1), input: { category: definition.categories, caseCount: cases.length } };
  const executions: TestExecution[] = [];
  try {
    const profiles = context.target.viewportProfiles.length ? context.target.viewportProfiles : [{ name: "default", width: context.target.viewport.width, height: context.target.viewport.height }];
    for (const testCase of cases.filter(item => definition.categories.includes(item.category))) for (const profile of profiles) { const execution = await executeCaseWithRetry({ ...context.target, viewport: { width: profile.width, height: profile.height }, viewportProfileName: profile.name }, testCase, `${context.artifactsDir}/${profile.name}`, context.retryBudget); execution.viewportProfile = profile.name; executions.push(execution); }
    task.status = "completed";
    return { task, executions, result: { taskId: task.id, status: "completed", observations: [`${definition.name} executed ${executions.length} case(s)`], evidence: executions.flatMap(item => item.evidence) } };
  } catch (error) { task.status = "failed"; return { task, executions, result: { taskId: task.id, status: "failed", observations: [], evidence: executions.flatMap(item => item.evidence), error: error instanceof Error ? error.message : String(error) } }; }
}

export function verifyAgent(run: TestRun, plan: TestPlan) { return { name: "verification", description: "Independent failure classification", findings: classifyFailures(run, plan) }; }
