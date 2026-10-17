import test from "node:test";
import assert from "node:assert/strict";
import { runDoctor } from "../../src/core/doctor.js";
import { locateProject } from "../../src/core/config.js";
import { tempProject } from "../helpers.js";

const target = { baseUrl: "http://127.0.0.1:3999", allowedOrigins: ["http://127.0.0.1:3999"], startPath: "/" };

test("doctor passes structural checks for a valid project", async () => {
  const dir = await tempProject({ target });
  const result = await runDoctor(locateProject({ projectDir: dir }), { launchBrowser: false, probeTarget: false });
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  assert.ok(result.checks.some(check => check.name === "sqlite" && check.status === "passed"));
  assert.ok(result.checks.some(check => check.name === "visual-baselines" && check.status === "warning"));
});

test("doctor fails when the configuration is missing", async () => {
  const dir = await tempProject({ target });
  const result = await runDoctor(locateProject({ projectDir: dir, configPath: "absent.json" }), { launchBrowser: false, probeTarget: false });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find(check => check.name === "configuration")?.status, "failed");
});

test("doctor reports a missing storage-state file and an unreachable target", async () => {
  const dir = await tempProject({ target: { ...target, storageStatePath: "state.json" } });
  const result = await runDoctor(locateProject({ projectDir: dir }), { launchBrowser: false });
  assert.equal(result.checks.find(check => check.name === "storage-state")?.status, "failed");
  assert.equal(result.checks.find(check => check.name === "target-reachable")?.status, "warning");
});
