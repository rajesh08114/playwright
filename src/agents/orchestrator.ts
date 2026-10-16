import { TestCase, TestExecution } from "../core/contracts.js";
import { AgentDefinition, AgentContext, runAgent, functionalAgent, uiAgent, accessibilityAgent } from "./agent.js";

export interface OrchestrationResult { agents: Array<{ name: string; taskId: string; status: string; executionCount: number; error?: string }>; executions: TestExecution[]; }

/** Runs each specialist over its own categories. Specialists run one after another to keep browser load bounded. */
export async function runSpecialists(context: AgentContext, cases: TestCase[], definitions: AgentDefinition[] = [functionalAgent, uiAgent, accessibilityAgent]): Promise<OrchestrationResult> {
  const outputs = [];
  for (const definition of definitions) outputs.push(await runAgent(definition, cases, context));
  return {
    agents: outputs.map(output => ({ name: output.task.agent, taskId: output.task.id, status: output.result.status, executionCount: output.executions.length, ...(output.result.error ? { error: output.result.error } : {}) })),
    executions: outputs.flatMap(output => output.executions)
  };
}
