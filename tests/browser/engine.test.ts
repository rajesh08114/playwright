import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Server } from "node:http";
import { Engine } from "../../src/core/engine.js";
import { close, listen, targetFor, tempProject } from "../helpers.js";

const { createDemoServer } = await import(new URL("../../../fixtures/demo-app/app.mjs", import.meta.url).href) as { createDemoServer(options?: { seeded?: boolean }): Server };
const profiles = [{ name: "mobile", width: 390, height: 844 }, { name: "desktop", width: 1280, height: 720 }];
const policy = { trace: "off" };

test("clean demo: discovery, planning, blocked baselines, approval, then a green run", async () => {
  const server = createDemoServer();
  const baseUrl = await listen(server);
  const engine = new Engine({ projectDir: await tempProject({ target: targetFor(baseUrl, { viewportProfiles: profiles }), budgets: { maxConcurrency: 2, maxRetries: 0 }, policy }) });
  try {
    const plan = await engine.planFromDiscovery();
    assert.deepEqual([...new Set(plan.cases.map(item => item.id.replace(/^TS-\w+-/, "")))].sort(), ["products", "root"]);
    const first = await engine.run(plan.id);
    const byOutcome = (outcome: string) => first.executions.filter(item => item.outcome === outcome).map(item => item.testCaseId);
    assert.deepEqual(byOutcome("failed"), [], JSON.stringify(first.executions.filter(item => item.outcome === "failed")));
    assert.equal(byOutcome("blocked").length, 4, "UI cases without baselines are blocked, never passed");
    assert.equal(first.status, "failed");
    assert.equal((await engine.baseline(first.id)).files.length, 4);
    const second = await engine.run(plan.id);
    assert.equal(second.status, "completed", JSON.stringify(second.executions.filter(item => item.outcome !== "passed")));
    const { files } = await engine.report(second.id);
    assert.match(await readFile(files.junit, "utf8"), /failures="0"/);
    const exported = await engine.exportPlan(plan.id);
    assert.match(await readFile(exported.file, "utf8"), /toHaveScreenshot/);
  } finally { engine.close(); await close(server); }
});

test("seeded demo: every seeded defect is detected in its expected category", async () => {
  const server = createDemoServer({ seeded: true });
  const baseUrl = await listen(server);
  const dir = await tempProject({ target: targetFor(baseUrl, { viewportProfiles: [profiles[0]] }), budgets: { maxConcurrency: 2, maxRetries: 0 }, policy, benchmarkOraclePath: "oracle.json" });
  await writeFile(join(dir, "oracle.json"), await readFile(new URL("../../../fixtures/demo-app/seeded-defects.json", import.meta.url), "utf8"));
  const engine = new Engine({ projectDir: dir });
  try {
    const plan = await engine.planFromDiscovery();
    const run = await engine.run(plan.id);
    const failed = new Set(run.executions.filter(item => item.outcome === "failed").map(item => item.testCaseId));
    for (const id of ["TS-FUNC-seeded-missing-heading", "TS-A11Y-seeded-unlabelled-input", "TS-RESP-seeded-overflow"]) assert.ok(failed.has(id), `${id} should fail; failed: ${[...failed].join(", ")}`);
    for (const id of ["TS-FUNC-root", "TS-A11Y-root", "TS-RESP-root"]) assert.equal(failed.has(id), false, `${id} should pass`);
    const { result } = await engine.benchmark(run.id);
    assert.equal(result.seededDefectRecall, 1);
    const findings = await engine.verify(run.id);
    assert.ok(findings.some(item => item.route === "/seeded/overflow" && item.category === "responsive"));
    const retest = await engine.retest(run.id);
    assert.equal(retest.retestOf, run.id);
    assert.ok(retest.executions.every(item => !["TS-FUNC-root", "TS-A11Y-root"].includes(item.testCaseId)), "retest only re-runs non-passing cases");
  } finally { engine.close(); await close(server); }
});

test("a cancel from another engine instance stops the run before its next case", async () => {
  const server = createDemoServer();
  const baseUrl = await listen(server);
  const dir = await tempProject({ target: targetFor(baseUrl, { viewportProfiles: profiles, routes: ["/products"] }), budgets: { maxConcurrency: 1, maxRetries: 0 }, policy });
  const runner = new Engine({ projectDir: dir }), other = new Engine({ projectDir: dir });
  try {
    const plan = await runner.plan();
    const { run, done } = await runner.start(plan.id);
    while ((await other.status(run.id)).executions.length < 1) await new Promise(resolve => setTimeout(resolve, 50));
    await other.cancel(run.id);
    const finished = await done;
    assert.equal(finished.status, "cancelled");
    assert.ok(finished.executions.length < plan.cases.length * profiles.length);
    const resumed = await runner.resume(run.id);
    assert.equal(resumed.executions.length >= plan.cases.length * profiles.length, true, "resume executes the remaining pairs");
  } finally { runner.close(); other.close(); await close(server); }
});
