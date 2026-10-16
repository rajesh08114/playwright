import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RunReport, TestRun, TestPlan } from "../core/contracts.js";

export function buildReport(run: TestRun, plan: TestPlan): RunReport {
  const byId = new Map(plan.cases.map(test => [test.id, test]));
  const failed = run.executions.filter(x => x.outcome === "failed");
  return { schemaVersion: 1, runId: run.id, generatedAt: new Date().toISOString(), summary: { total: run.executions.length, passed: run.executions.filter(x => x.outcome === "passed").length, failed: failed.length, blocked: run.executions.filter(x => x.outcome === "blocked").length }, executions: run.executions, findings: failed.map(execution => { const test = byId.get(execution.testCaseId); return { findingId: randomUUID(), runId: run.id, affectedFeature: test?.feature ?? "unknown", route: test?.steps[0] ?? "unknown", category: test?.category ?? "functional", severity: test?.priority === "critical" ? "critical" : test?.priority === "high" ? "high" : "medium", confidence: 0.6, reproduction: test?.steps ?? [], verificationState: "unverified", evidenceReferences: execution.evidence.map(x => x.id), remediation: "Reproduce the scenario and inspect the referenced evidence before changing application code." }; }) };
}
export async function writeReport(report: RunReport, directory: string) {
  await mkdir(directory, { recursive: true });
  const json = join(directory, `${report.runId}.json`), html = join(directory, `${report.runId}.html`);
  await writeFile(json, JSON.stringify(report, null, 2));
  const rows = report.executions.map(x => `<tr><td>${x.testCaseId}</td><td>${x.outcome}</td><td>${x.error ?? ""}</td></tr>`).join("");
  await writeFile(html, `<!doctype html><meta charset="utf-8"><title>TestSwarm ${report.runId}</title><h1>TestSwarm run ${report.runId}</h1><p>${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.blocked} blocked</p><table><tr><th>Test</th><th>Outcome</th><th>Error</th></tr>${rows}</table>`);
  const junit = join(directory, `${report.runId}.xml`), cases = report.executions.map(x => x.outcome === "passed" ? `<testcase name="${x.testCaseId}"/>` : `<testcase name="${x.testCaseId}"><failure message="${(x.error ?? x.outcome).replaceAll('"', '&quot;')}"/></testcase>`).join("");
  await writeFile(junit, `<?xml version="1.0" encoding="UTF-8"?><testsuite name="testswarm" tests="${report.summary.total}" failures="${report.summary.failed}" skipped="${report.summary.blocked}">${cases}</testsuite>`);
  return { json, html, junit };
}
