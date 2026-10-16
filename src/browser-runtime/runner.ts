import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium, firefox, webkit, type BrowserType, type Browser } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { ApplicationTarget, TestCase, TestExecution, EvidenceArtifact } from "../core/contracts.js";
import { redactSensitive } from "../evidence/redact.js";

export interface ExecutionHooks { afterLaunch?: (browser: Browser) => Promise<void>; }
export async function executeCase(target: ApplicationTarget, testCase: TestCase, artifactsDir: string, hooks?: ExecutionHooks): Promise<TestExecution> {
  const startedAt = new Date().toISOString(), id = randomUUID(), dir = join(artifactsDir, id);
  await mkdir(dir, { recursive: true });
  const evidence: EvidenceArtifact[] = [], consoleErrors: string[] = [], failedRequests: string[] = [];
  const type: BrowserType = target.browser === "firefox" ? firefox : target.browser === "webkit" ? webkit : chromium;
  let browser;
  try {
    browser = await type.launch({ headless: true, executablePath: target.executablePath });
    if (hooks?.afterLaunch) await hooks.afterLaunch(browser);
    const context = await browser.newContext({ baseURL: target.baseUrl, viewport: target.viewport, storageState: target.storageStatePath });
    await context.route("**/*", async route => { const requestUrl = new URL(route.request().url()); if (requestUrl.origin === new URL(target.baseUrl).origin || ["data:", "blob:"].includes(requestUrl.protocol)) await route.continue(); else await route.abort("blockedbyclient"); });
    const page = await context.newPage();
    page.setDefaultTimeout(target.actionTimeoutMs); page.setDefaultNavigationTimeout(target.navigationTimeoutMs);
    page.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("requestfailed", r => failedRequests.push(`${r.method()} ${r.url()}: ${r.failure()?.errorText ?? "failed"}`));
    const navigationStep = testCase.steps.find(step => /^Navigate to /i.test(step));
    const requestedPath = navigationStep ? navigationStep.replace(/^Navigate to /i, "").trim() : target.startPath;
    const url = new URL(requestedPath, target.baseUrl);
    if (!target.allowedOrigins.includes(url.origin)) throw new Error("Target path resolves outside allowed origins");
    await page.goto(url.href, { waitUntil: "domcontentloaded" });
    if (new URL(page.url()).origin !== new URL(target.baseUrl).origin) throw new Error("Navigation redirect left the allowed origin");
    const heading = page.getByRole("heading").first();
    await heading.waitFor({ state: "visible" });
    if (testCase.category === "responsive") {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      if (overflow) throw new Error(`Horizontal overflow detected: document width exceeds viewport (${target.viewport.width}px)`);
    }
    const screenshot = join(dir, "page.png"); await page.screenshot({ path: screenshot, fullPage: true });
    evidence.push({ id: randomUUID(), kind: "screenshot", path: screenshot, description: "Full page after navigation" });
    if (testCase.category === "ui" && target.visualBaselinesDir) {
      const baseline = join(target.visualBaselinesDir, `${testCase.id}-${target.viewportProfileName ?? "default"}.png`);
      try { const [actual, expected] = await Promise.all([readFile(screenshot), readFile(baseline)]); if (!actual.equals(expected)) throw new Error(`Visual baseline mismatch for ${testCase.id}`); }
      catch (error) { if (error instanceof Error && error.message.startsWith("Visual baseline mismatch")) throw error; if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Missing visual baseline for ${testCase.id}`); throw error; }
    }
    const accessibility = await new AxeBuilder({ page }).analyze();
    const accessibilityPath = join(dir, "accessibility.json"); await import("node:fs/promises").then(fs => fs.writeFile(accessibilityPath, JSON.stringify(accessibility, null, 2)));
    evidence.push({ id: randomUUID(), kind: "accessibility", path: accessibilityPath, description: `${accessibility.violations.length} axe accessibility violation(s)` });
    if (consoleErrors.length) { const p = join(dir, "console.json"); await import("node:fs/promises").then(fs => fs.writeFile(p, JSON.stringify(consoleErrors.map(redactSensitive), null, 2), { mode: 0o600 })); evidence.push({ id: randomUUID(), kind: "console", path: p, description: "Redacted browser console errors" }); }
    if (failedRequests.length) { const p = join(dir, "network.json"); await import("node:fs/promises").then(fs => fs.writeFile(p, JSON.stringify(failedRequests.map(redactSensitive), null, 2), { mode: 0o600 })); evidence.push({ id: randomUUID(), kind: "network", path: p, description: "Redacted failed network requests" }); }
    await context.close(); await browser.close();
    return { id, testCaseId: testCase.id, outcome: "passed", startedAt, finishedAt: new Date().toISOString(), evidence };
  } catch (error) {
    if (browser) await browser.close().catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    const infrastructure = /executable doesn't exist|browser has been closed|target page, context or browser has been closed|browser disconnected/i.test(message);
    return { id, testCaseId: testCase.id, outcome: message.startsWith("Missing visual baseline") ? "blocked" : infrastructure ? "infrastructure_failure" : "failed", startedAt, finishedAt: new Date().toISOString(), error: message, evidence };
  }
}

export async function executeCaseWithRetry(target: ApplicationTarget, testCase: TestCase, artifactsDir: string, retries = 0): Promise<TestExecution> {
  const attempts: TestExecution[] = [];
  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await executeCase(target, testCase, join(artifactsDir, `attempt-${attempt + 1}`));
    attempts.push(result);
    if (result.outcome === "passed") return attempt === 0 ? result : { ...result, outcome: "flaky", error: `Passed after ${attempt} retry attempt(s)` };
  }
  return attempts[attempts.length - 1];
}
