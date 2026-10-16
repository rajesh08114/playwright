import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TestPlan, TestRun, SeededDefect } from "../core/contracts.js";

export function measureRun(run: TestRun, plan: TestPlan, oracle: SeededDefect[] = []) {
  const executions = run.executions;
  const testedCaseIds = new Set(executions.map(execution => execution.testCaseId));
  const profiles = [...new Set(executions.map(execution => execution.viewportProfile ?? "default"))];
  const failedRoutes = new Set(run.executions.filter(execution => ["failed", "infrastructure_failure"].includes(execution.outcome)).map(execution => plan.cases.find(testCase => testCase.id === execution.testCaseId)?.steps[0]?.replace(/^Navigate to /, "")));
  const detected = oracle.filter(defect => failedRoutes.has(defect.route));
  return {
    schemaVersion: 1,
    runId: run.id,
    measuredAt: new Date().toISOString(),
    planCases: plan.cases.length,
    executedCases: testedCaseIds.size,
    caseCoverage: plan.cases.length ? testedCaseIds.size / plan.cases.length : 0,
    executions: executions.length,
    outcomes: { passed: executions.filter(x => x.outcome === "passed").length, failed: executions.filter(x => x.outcome === "failed").length, flaky: executions.filter(x => x.outcome === "flaky").length, blocked: executions.filter(x => x.outcome === "blocked").length },
    viewportProfiles: profiles,
    evidenceArtifacts: executions.reduce((count, execution) => count + execution.evidence.length, 0),
    seededDefectRecall: oracle.length ? detected.length / oracle.length : null,
    seededDefects: oracle.length ? { total: oracle.length, detected: detected.map(defect => defect.id), missed: oracle.filter(defect => !failedRoutes.has(defect.route)).map(defect => defect.id) } : null,
    limitations: oracle.length ? [] : ["Seeded-defect recall is null until a controlled defect oracle is configured."]
  };
}
export async function writeBenchmark(result: ReturnType<typeof measureRun>, directory: string) { await mkdir(directory, { recursive: true }); const file = join(directory, `${result.runId}.json`); await writeFile(file, JSON.stringify(result, null, 2)); return file; }
