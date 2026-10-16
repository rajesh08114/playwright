import test from "node:test";
import assert from "node:assert/strict";
import { compareRuns } from "../../src/benchmarks/compare.js";

test("benchmark comparison reports outcome deltas", () => {
  const base = { id: "a", projectName: "p", planId: "plan", status: "completed" as const, startedAt: "now", executions: [] };
  const first = { ...base, executions: [{ id: "1", testCaseId: "t", outcome: "passed" as const, startedAt: "now", finishedAt: "now", evidence: [] }] };
  const second = { ...base, id: "b", executions: [{ id: "2", testCaseId: "t", outcome: "failed" as const, startedAt: "now", finishedAt: "now", evidence: [] }] };
  assert.deepEqual(compareRuns(first, second).deltas, { passed: -1, failed: 1, flaky: 0, blocked: 0, infrastructure: 0 });
});
