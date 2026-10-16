import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { ApplicationTarget, TestCase } from "../../src/core/contracts.js";
import { executeCase } from "../../src/browser-runtime/runner.js";

test("browser launch failures are infrastructure failures", async () => {
  const target = ApplicationTarget.parse({ baseUrl: "http://127.0.0.1:3999", allowedOrigins: ["http://127.0.0.1:3999"], startPath: "/", executablePath: "C:/does-not-exist/testswarm-browser.exe" });
  const testCase: TestCase = { id: "infra-1", title: "infra", feature: "infra", category: "functional", priority: "low", preconditions: [], steps: ["Navigate to /"], assertions: ["heading"], expectedOutcome: "pass", requiredEvidence: [], timeoutMs: 1000, destructive: "none" };
  await mkdir(".testswarm/runtime-test", { recursive: true });
  const result = await executeCase(target, testCase, ".testswarm/runtime-test");
  assert.equal(result.outcome, "infrastructure_failure");
});
