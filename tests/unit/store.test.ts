import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteStore, JsonStore, Store } from "../../src/core/store.js";
import { createStarterPlan } from "../../src/planner/planner.js";
import type { TestExecution } from "../../src/core/contracts.js";

const dir = () => mkdtemp(join(tmpdir(), "testswarm-store-"));
const execution = (id: string, outcome: TestExecution["outcome"] = "passed"): TestExecution => ({ id, testCaseId: "TS-FUNC-root", viewportProfile: "default", outcome, startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", evidence: [] });

for (const [name, make] of [["sqlite", async () => new SqliteStore(join(await dir(), "t.db"))], ["json", async () => new JsonStore(join(await dir(), "t.json"))]] as Array<[string, () => Promise<Store>]>) {
  test(`${name} store round-trips plans, runs, and appended executions`, async () => {
    const store = await make();
    const plan = createStarterPlan();
    await store.putPlan(plan);
    await store.putRun({ id: "r1", projectName: "p", planId: plan.id, status: "running", startedAt: new Date().toISOString(), executions: [] });
    await store.addExecution("r1", execution("e1", "failed"));
    await store.addExecution("r1", execution("e2"));
    await store.putRun({ id: "r1", projectName: "p", planId: plan.id, status: "failed", startedAt: new Date().toISOString(), executions: [] });
    const run = await store.getRun("r1");
    assert.equal(run?.status, "failed");
    assert.deepEqual(run?.executions.map(item => item.id), ["e1", "e2"], "putRun must not drop appended executions");
    assert.equal((await store.getPlan(plan.id))?.id, plan.id);
    store.close();
  });

  test(`${name} store persists cancellation requests and prunes old finished runs`, async () => {
    const store = await make();
    const plan = createStarterPlan();
    await store.putPlan(plan);
    for (const [index, status] of (["completed", "failed", "running"] as const).entries()) await store.putRun({ id: `r${index}`, projectName: "p", planId: plan.id, status, startedAt: `2026-01-0${index + 1}T00:00:00Z`, executions: [] });
    assert.equal(await store.isCancelRequested("r2"), false);
    await store.requestCancel("r2");
    assert.equal(await store.isCancelRequested("r2"), true);
    await store.requestCancel("r2", false);
    assert.equal(await store.isCancelRequested("r2"), false);
    assert.deepEqual(await store.pruneRuns(1), ["r0"]);
    assert.deepEqual((await store.listRuns()).map(run => run.id).sort(), ["r1", "r2"]);
    store.close();
  });
}

test("persisted running state survives store recreation for resume", async () => {
  const file = join(await dir(), "recovery.db");
  const first = new SqliteStore(file), plan = createStarterPlan();
  await first.putPlan(plan);
  await first.putRun({ id: "recovery-run", projectName: "demo", planId: plan.id, status: "running", startedAt: new Date().toISOString(), executions: [] });
  await first.addExecution("recovery-run", execution("e1"));
  first.close();
  const second = new SqliteStore(file), restored = await second.getRun("recovery-run");
  assert.equal(restored?.status, "running");
  assert.equal(restored?.executions.length, 1);
  second.close();
});

test("version 1 databases migrate embedded executions into rows", async () => {
  const file = join(await dir(), "v1.db");
  const legacy = new DatabaseSync(file);
  const plan = createStarterPlan();
  legacy.exec("CREATE TABLE plans (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL); CREATE TABLE runs (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY (plan_id) REFERENCES plans(id)); PRAGMA user_version = 1;");
  legacy.prepare("INSERT INTO plans VALUES (?,?,?)").run(plan.id, JSON.stringify(plan), plan.generatedAt);
  legacy.prepare("INSERT INTO runs VALUES (?,?,?,?,?)").run("old", plan.id, "failed", JSON.stringify({ id: "old", projectName: "p", planId: plan.id, status: "failed", startedAt: "2026-01-01T00:00:00Z", executions: [execution("a", "failed"), execution("b")] }), "2026-01-01T00:00:00Z");
  legacy.close();
  const store = new SqliteStore(file);
  assert.deepEqual((await store.getRun("old"))?.executions.map(item => item.id), ["a", "b"]);
  store.close();
});
