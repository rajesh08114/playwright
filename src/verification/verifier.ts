import { createHash } from "node:crypto";
import { TestRun, TestPlan, DefectFinding } from "../core/contracts.js";
import { navigationPath } from "../browser-runtime/runner.js";

/**
 * Turns failed executions into findings, one per test case (all viewport profiles that failed the same case are
 * merged). Findings stay "unverified" unless the same case failed on every profile it ran on, which makes it "probable".
 */
export function classifyFailures(run: TestRun, plan: TestPlan): DefectFinding[] {
  const cases = new Map(plan.cases.map(test => [test.id, test]));
  const byCase = new Map<string, typeof run.executions>();
  for (const execution of run.executions) byCase.set(execution.testCaseId, [...(byCase.get(execution.testCaseId) ?? []), execution]);
  const findings: DefectFinding[] = [];
  for (const [caseId, executions] of byCase) {
    const failed = executions.filter(item => item.outcome === "failed");
    if (!failed.length) continue;
    const test = cases.get(caseId);
    const everyProfile = failed.length === executions.length;
    findings.push({
      findingId: createHash("sha256").update(`${run.id}:${caseId}`).digest("hex").slice(0, 16),
      runId: run.id,
      affectedFeature: test?.feature ?? "unknown",
      route: test ? navigationPath(test, "/") : "unknown",
      category: test?.category ?? "functional",
      severity: test?.priority === "critical" ? "critical" : test?.priority === "high" ? "high" : test?.priority === "low" ? "low" : "medium",
      confidence: everyProfile ? 0.8 : 0.5,
      reproduction: [...(test?.steps ?? []), `Viewport profile(s): ${failed.map(item => item.viewportProfile ?? "default").join(", ")}`, `Observed: ${failed[0].error ?? "failed"}`],
      verificationState: everyProfile ? "probable" : "unverified",
      evidenceReferences: failed.flatMap(item => item.evidence.map(evidence => evidence.id)),
      remediation: "Inspect the attached screenshot and trace, then retest before treating this as a confirmed defect."
    });
  }
  return findings;
}
