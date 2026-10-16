import { TestRun, TestPlan, DefectFinding } from "../core/contracts.js";
import { randomUUID } from "node:crypto";
export function classifyFailures(run: TestRun, plan: TestPlan): DefectFinding[] {
  const cases = new Map(plan.cases.map(test => [test.id, test]));
  return run.executions.filter(x => x.outcome === "failed").map(x => { const test = cases.get(x.testCaseId); return { findingId: randomUUID(), runId: run.id, affectedFeature: test?.feature ?? "unknown", route: test?.steps[0] ?? "unknown", category: test?.category ?? "functional", severity: test?.priority === "critical" ? "critical" : test?.priority === "high" ? "high" : "medium", confidence: 0.5, reproduction: test?.steps ?? [], verificationState: "unverified", evidenceReferences: x.evidence.map(e => e.id), remediation: "Run verification before treating this observation as a confirmed defect." }; });
}
