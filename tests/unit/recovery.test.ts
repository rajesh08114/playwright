import test from "node:test";
import assert from "node:assert/strict";
import { SqliteStore } from "../../src/core/store.js";
import { createStarterPlan } from "../../src/planner/planner.js";

test("persisted running state survives store recreation for resume", async () => {
  const file = ".testswarm/recovery-test.db";
  const first = new SqliteStore(file); const plan = createStarterPlan(); await first.putPlan(plan); await first.putRun({ id: "recovery-run", projectName: "demo", planId: plan.id, status: "running", startedAt: new Date().toISOString(), executions: [] }); first.close();
  const second = new SqliteStore(file); const restored = await second.getRun("recovery-run"); assert.equal(restored?.status, "running"); assert.equal(restored?.planId, plan.id); second.close();
});
