import test from "node:test";
import assert from "node:assert/strict";
import { SqliteStore } from "../../src/core/store.js";
import { createStarterPlan } from "../../src/planner/planner.js";

test("SQLite store round-trips plans and runs", async () => {
  const store = new SqliteStore(".testswarm/store-test.db");
  const plan = createStarterPlan();
  await store.putPlan(plan);
  const run = { id: "store-run", projectName: "test", planId: plan.id, status: "queued" as const, startedAt: new Date().toISOString(), executions: [] };
  await store.putRun(run);
  assert.equal((await store.getPlan(plan.id))?.id, plan.id);
  assert.equal((await store.getRun(run.id))?.status, "queued");
  assert.equal((await store.listRuns()).some(item => item.id === run.id), true);
  store.close();
});
