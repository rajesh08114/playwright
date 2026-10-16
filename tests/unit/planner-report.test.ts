import test from "node:test";
import assert from "node:assert/strict";
import { createPlanFromDiscovery } from "../../src/planner/planner.js";
import { buildReport } from "../../src/reporting/report.js";
import type { DiscoveryResult, TestRun } from "../../src/core/contracts.js";

const discovery: DiscoveryResult = { schemaVersion: 1, startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", warnings: [], routes: [{ path: "/", title: "Home", heading: "Welcome", source: "browser-observed", confidence: 0.9, links: ["/products"], forms: 1, interactiveElements: 2 }], features: [] };
test("discovery produces a reviewable set of safe test cases", () => { const plan = createPlanFromDiscovery(discovery); assert.equal(plan.cases.length, 3); assert.equal(plan.cases[0].destructive, "none"); assert.equal(plan.cases[1].category, "accessibility"); assert.equal(plan.cases[2].category, "responsive"); });
test("report preserves outcomes and creates unverified findings for failures", () => { const plan = createPlanFromDiscovery(discovery); const run: TestRun = { id: "run-1", projectName: "demo", planId: plan.id, status: "failed", startedAt: "2026-01-01T00:00:00Z", executions: [{ id: "exec-1", testCaseId: plan.cases[0].id, outcome: "failed", startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", error: "heading missing", evidence: [] }] }; const report = buildReport(run, plan); assert.deepEqual(report.summary, { total: 1, passed: 0, failed: 1, blocked: 0 }); assert.equal(report.findings[0].verificationState, "unverified"); });
