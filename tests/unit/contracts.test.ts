import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { ApplicationTarget, ProjectConfiguration } from "../../src/core/contracts.js";
import { loadConfig, locateProject } from "../../src/core/config.js";
import { tempProject } from "../helpers.js";

test("target schema rejects malformed origins", () => {
  assert.equal(ApplicationTarget.safeParse({ baseUrl: "not-a-url", allowedOrigins: [], startPath: "/" }).success, false);
});

test("policy defaults are filled in when policy is omitted", () => {
  const config = ProjectConfiguration.parse({ schemaVersion: 1, name: "x", target: { baseUrl: "http://127.0.0.1:3000", allowedOrigins: ["http://127.0.0.1:3000"], startPath: "/" } });
  assert.equal(config.policy.accessibilityFailOn, "serious");
  assert.equal(config.policy.allowExternalNetwork, false);
  assert.equal(config.policy.trace, "retain-on-failure");
});

for (const host of ["169.254.169.254", "0.0.0.0", "metadata.google.internal"]) {
  test(`project policy rejects ${host}`, async () => {
    const dir = await tempProject({ target: { baseUrl: `http://${host}`, allowedOrigins: [`http://${host}`], startPath: "/" } });
    await assert.rejects(() => loadConfig(undefined, dir), /not permitted/);
  });
}

test("baseUrl must be an allowed origin", async () => {
  const dir = await tempProject({ target: { baseUrl: "http://127.0.0.1:3000", allowedOrigins: ["http://127.0.0.1:4000"], startPath: "/" } });
  await assert.rejects(() => loadConfig(undefined, dir), /baseUrl must belong/);
});

test("relative paths resolve against the project directory, not the working directory", async () => {
  const dir = await tempProject({ artifactsDir: "out", target: { baseUrl: "http://127.0.0.1:3000", allowedOrigins: ["http://127.0.0.1:3000"], startPath: "/", storageStatePath: "auth/state.json" } });
  const config = await loadConfig(undefined, dir);
  assert.equal(config.artifactsDir, join(dir, "out"));
  assert.equal(config.target.storageStatePath, join(dir, "auth/state.json"));
  assert.equal(config.target.visualBaselinesDir, join(dir, "out", "visual-baselines"));
});

test("missing configuration produces an actionable error", async () => {
  const dir = await tempProject();
  await assert.rejects(() => loadConfig("missing.json", dir), /Configuration not found.*testswarm init/);
});

test("locateProject honours explicit options over the environment", () => {
  const location = locateProject({ projectDir: "/tmp/project-x", configPath: "custom.json" });
  assert.equal(location.root, resolve("/tmp/project-x"));
  assert.equal(location.configPath, resolve("/tmp/project-x", "custom.json"));
});
