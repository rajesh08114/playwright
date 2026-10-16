import { ApplicationTarget, TestCase, TestExecution } from "../core/contracts.js";
import { AgentDefinition, AgentContext, runAgent, functionalAgent, uiAgent, accessibilityAgent } from "./agent.js";

export interface OrchestrationResult { agents: Array<{ name: string; taskId: string; status: string; executionCount: number }>; executions: TestExecution[]; }
export async function runSpecialists(target: ApplicationTarget, cases: TestCase[], artifactsDir: string, retryBudget: number, definitions: AgentDefinition[] = [functionalAgent, uiAgent, accessibilityAgent]): Promise<OrchestrationResult> {
  const context: AgentContext = { target, artifactsDir, retryBudget };
  const outputs = [];
  for (const definition of definitions) outputs.push(await runAgent(definition, cases, context));
  return { agents: outputs.map(output => ({ name: output.task.agent, taskId: output.task.id, status: output.result.status, executionCount: output.executions.length })), executions: outputs.flatMap(output => output.executions) };
}
