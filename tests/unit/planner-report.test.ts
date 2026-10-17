import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlanFromDiscovery, routeSlug } from "../../src/planner/planner.js";
import { buildReport, writeReport } from "../../src/reporting/report.js";
import { classifyFailures } from "../../src/verification/verifier.js";
import type { DiscoveryResult, TestRun } from "../../src/core/contracts.js";

const route = (path: string) => ({ path, title: "T", heading: "H", source: "browser-observed" as const, confidence: 0.9, links: [], forms: 0, interactiveElements: 0 });
const discovery: DiscoveryResult = { schemaVersion: 1, startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", warnings: [], routes: [route("/"), route("/products")], features: [] };

test("discovery produces four safe cases per route with stable ids", () => {
  const plan = createPlanFromDiscovery(discovery);
  assert.equal(plan.cases.length, 8);
  assert.deepEqual(plan.cases.slice(0, 4).map(item => item.id), ["TS-FUNC-root", "TS-A11Y-root", "TS-RESP-root", "TS-UI-root"]);
  assert.ok(plan.cases.every(item => item.destructive === "none"));
  assert.equal(createPlanFromDiscovery({ ...discovery, routes: [route("/products"), route("/")] }).cases[0].id, "TS-FUNC-products", "ids depend on the route, not discovery order");
});

test("plans honour maxCases and category filters", () => {
  assert.equal(createPlanFromDiscovery(discovery, { maxCases: 3 }).cases.length, 3);
  assert.ok(createPlanFromDiscovery(discovery, { categories: ["functional"] }).cases.every(item => item.category === "functional"));
});

test("route slugs are filesystem safe", () => {
  assert.equal(routeSlug("/"), "root");
  assert.equal(routeSlug("/a/b?c=1&d=<x>"), "a-b-c-1-d-x");
});

const plan = createPlanFromDiscovery(discovery);
const run: TestRun = { id: "run-1", projectName: "demo", planId: plan.id, status: "failed", startedAt: "2026-01-01T00:00:00Z", executions: [
  { id: "e1", testCaseId: "TS-FUNC-root", viewportProfile: "mobile", outcome: "failed", startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", error: 'No visible heading <script>alert("x")</script> & more', evidence: [] },
  { id: "e2", testCaseId: "TS-FUNC-root", viewportProfile: "desktop", outcome: "failed", startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", error: "No visible heading", evidence: [] },
  { id: "e3", testCaseId: "TS-UI-root", viewportProfile: "desktop", outcome: "blocked", startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", error: "Missing visual baseline", evidence: [] },
  { id: "e4", testCaseId: "TS-RESP-root", viewportProfile: "desktop", outcome: "flaky", startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", evidence: [] }
] };

test("report summarises every outcome and merges failures per case", () => {
  const report = buildReport(run, plan);
  assert.deepEqual(report.summary, { total: 4, passed: 0, failed: 2, flaky: 1, blocked: 1, infrastructure: 0 });
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].verificationState, "probable", "failing on every profile raises confidence");
  assert.equal(report.findings[0].route, "/");
});

test("verifier keeps single-profile failures unverified", () => {
  const partial = { ...run, executions: [run.executions[0], { ...run.executions[1], outcome: "passed" as const }] };
  assert.equal(classifyFailures(partial, plan)[0].verificationState, "unverified");
});

test("HTML and JUnit reports escape untrusted text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "testswarm-report-"));
  const files = await writeReport(buildReport(run, plan), dir, plan);
  const html = await readFile(files.html, "utf8"), xml = await readFile(files.junit, "utf8");
  assert.equal(html.includes("<script>"), false);
  assert.match(html, /&lt;script&gt;/);
  assert.equal(/<script>|& more/.test(xml), false);
  assert.match(xml, /failures="2"/);
  assert.match(xml, /<skipped /);
});
