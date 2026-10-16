import { TestRun } from "../core/contracts.js";

export function compareRuns(first: TestRun, second: TestRun) {
  const outcomes = (run: TestRun) => ({ total: run.executions.length, passed: run.executions.filter(item => item.outcome === "passed").length, failed: run.executions.filter(item => item.outcome === "failed").length, flaky: run.executions.filter(item => item.outcome === "flaky").length, blocked: run.executions.filter(item => item.outcome === "blocked").length, infrastructure: run.executions.filter(item => item.outcome === "infrastructure_failure").length });
  const a = outcomes(first), b = outcomes(second);
  return { schemaVersion: 1, planId: first.planId, firstRunId: first.id, secondRunId: second.id, first: a, second: b, deltas: { passed: b.passed - a.passed, failed: b.failed - a.failed, flaky: b.flaky - a.flaky, blocked: b.blocked - a.blocked, infrastructure: b.infrastructure - a.infrastructure }, equivalentPlan: first.planId === second.planId };
}
