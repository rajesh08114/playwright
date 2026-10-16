import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { ApplicationTarget, TestCase } from "../../src/core/contracts.js";
import { executeCase } from "../../src/browser-runtime/runner.js";

test("a browser disconnected immediately after launch is infrastructure failure", async () => {
  const target = ApplicationTarget.parse({ baseUrl: "http://127.0.0.1:3999", allowedOrigins: ["http://127.0.0.1:3999"], startPath: "/", executablePath: "C:/Users/chall/AppData/Local/ms-playwright/chromium-1134/chrome-win/chrome.exe" });
  const testCase: TestCase = { id: "crash-1", title: "crash", feature: "infra", category: "functional", priority: "low", preconditions: [], steps: ["Navigate to /"], assertions: ["heading"], expectedOutcome: "pass", requiredEvidence: [], timeoutMs: 1000, destructive: "none" };
  await mkdir(".testswarm/crash-test", { recursive: true });
  const result = await executeCase(target, testCase, ".testswarm/crash-test", { afterLaunch: async browser => { await browser.close(); } });
  assert.equal(result.outcome, "infrastructure_failure");
});
