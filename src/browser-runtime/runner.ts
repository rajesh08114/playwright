import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, firefox, webkit, type Browser, type BrowserType, type Page } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { ApplicationTarget, EvidenceArtifact, Impact, Policy, TestCase, TestExecution } from "../core/contracts.js";
import { redactSensitive } from "../evidence/redact.js";
import { MissingSecretError, runActions, usesSecrets } from "./actions.js";

export interface ExecutionHooks { afterLaunch?: (browser: Browser) => Promise<void>; }
export interface ExecutionOptions {
  /** Shared browser; when omitted the case launches and closes its own. */
  browser?: Browser;
  policy?: Partial<Policy>;
  hooks?: ExecutionHooks;
}

const DEFAULT_POLICY = Policy.parse({});
const IMPACT_RANK: Record<Impact, number> = { minor: 0, moderate: 1, serious: 2, critical: 3 };
const INFRASTRUCTURE_ERROR = /executable doesn't exist|browser has been closed|target page, context or browser has been closed|browser disconnected|failed to launch|browserType\.launch/i;

/** A deliberate test verdict that is not a failure of the product (missing baseline, policy refusal). */
class BlockedError extends Error {}

export function browserType(target: ApplicationTarget): BrowserType {
  return target.browser === "firefox" ? firefox : target.browser === "webkit" ? webkit : chromium;
}

export function launchBrowser(target: ApplicationTarget) {
  return browserType(target).launch({ headless: true, executablePath: target.executablePath ?? (process.env.TESTSWARM_BROWSER_PATH || undefined) });
}

/** Lazily launches one browser and relaunches it if it disconnects, so a crash costs one case, not the run. */
export class BrowserPool {
  private browser?: Promise<Browser>;
  constructor(private readonly target: ApplicationTarget) {}
  async acquire(): Promise<Browser> {
    if (this.browser) {
      const current = await this.browser.catch(() => undefined);
      if (current?.isConnected()) return current;
    }
    this.browser = launchBrowser(this.target);
    return this.browser;
  }
  async close() { const current = await this.browser?.catch(() => undefined); this.browser = undefined; await current?.close().catch(() => undefined); }
}

export function baselineFile(target: ApplicationTarget, testCase: TestCase) {
  return join(target.visualBaselinesDir ?? ".testswarm/visual-baselines", `${testCase.id}-${target.viewportProfileName ?? "default"}.png`);
}

/** The path of the first "Navigate to <path>" step, or the target's start path. */
export function navigationPath(testCase: TestCase, fallback: string) {
  const step = testCase.steps.find(item => /^Navigate to /i.test(item));
  return step ? step.replace(/^Navigate to /i, "").trim() : fallback;
}

export async function executeCase(target: ApplicationTarget, testCase: TestCase, artifactsDir: string, options: ExecutionOptions = {}): Promise<TestExecution> {
  const policy = { ...DEFAULT_POLICY, ...options.policy };
  const startedAt = new Date().toISOString(), id = randomUUID(), dir = join(artifactsDir, id);
  const evidence: EvidenceArtifact[] = [], consoleErrors: string[] = [], failedRequests: string[] = [], blockedRequests: string[] = [], failures: string[] = [];
  const redact = (value: string) => policy.redactSecrets ? redactSensitive(value) : value;
  const allowed = new Set(target.allowedOrigins.map(origin => new URL(origin).origin));
  let ownBrowser: Browser | undefined;
  let context: Awaited<ReturnType<Browser["newContext"]>> | undefined;
  let tracing = false;
  const finish = async (outcome: TestExecution["outcome"], error?: string): Promise<TestExecution> => {
    await writeNetworkEvidence();
    if (context && tracing) {
      const keep = policy.trace === "on" || (policy.trace === "retain-on-failure" && outcome !== "passed");
      const tracePath = join(dir, "trace.zip");
      await context.tracing.stop(keep ? { path: tracePath } : undefined).then(() => { if (keep) evidence.push({ id: randomUUID(), kind: "trace", path: tracePath, description: "Playwright trace (open with npx playwright show-trace)" }); }).catch(() => undefined);
    }
    await context?.close().catch(() => undefined);
    await ownBrowser?.close().catch(() => undefined);
    return { id, testCaseId: testCase.id, viewportProfile: target.viewportProfileName, outcome, startedAt, finishedAt: new Date().toISOString(), ...(error ? { error } : {}), evidence };
  };
  const writeNetworkEvidence = async () => {
    if (consoleErrors.length) { const path = join(dir, "console.json"); await writeFile(path, JSON.stringify(consoleErrors.map(redact), null, 2), { mode: 0o600 }); evidence.push({ id: randomUUID(), kind: "console", path, description: `${consoleErrors.length} browser console error(s)${policy.redactSecrets ? ", redacted" : ""}` }); }
    if (failedRequests.length || blockedRequests.length) { const path = join(dir, "network.json"); await writeFile(path, JSON.stringify({ failed: failedRequests.map(redact), blockedByPolicy: blockedRequests.map(redact) }, null, 2), { mode: 0o600 }); evidence.push({ id: randomUUID(), kind: "network", path, description: `${failedRequests.length} failed and ${blockedRequests.length} policy-blocked request(s)` }); }
  };

  try {
    await mkdir(dir, { recursive: true });
    if (testCase.destructive !== "none" && !policy.allowDestructiveActions) throw new BlockedError(`Case is marked ${testCase.destructive}; set policy.allowDestructiveActions to run it`);
    const url = new URL(navigationPath(testCase, target.startPath), target.baseUrl);
    if (!allowed.has(url.origin)) throw new BlockedError(`Target ${url.origin} is outside target.allowedOrigins`);

    let browser = options.browser;
    if (!browser) { browser = ownBrowser = await launchBrowser(target); }
    if (options.hooks?.afterLaunch) await options.hooks.afterLaunch(browser);
    context = await browser.newContext({ baseURL: target.baseUrl, viewport: target.viewport, storageState: target.storageStatePath, reducedMotion: "reduce" });
    // Traces record typed text, so a case that fills secrets from the environment is never traced.
    if (policy.trace !== "off" && !usesSecrets(testCase.actions)) { await context.tracing.start({ screenshots: true, snapshots: true }); tracing = true; }
    await context.route("**/*", async route => {
      const request = route.request(), requestUrl = new URL(request.url());
      const isAllowedOrigin = allowed.has(requestUrl.origin) || ["data:", "blob:"].includes(requestUrl.protocol);
      const isTopLevelNavigation = request.isNavigationRequest() && request.frame().parentFrame() === null;
      if (isAllowedOrigin || (policy.allowExternalNetwork && !isTopLevelNavigation)) return route.continue();
      blockedRequests.push(`${request.method()} ${request.url()}`);
      return route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    page.setDefaultTimeout(target.actionTimeoutMs);
    page.setDefaultNavigationTimeout(target.navigationTimeoutMs);
    // Resource errors caused by our own origin policy are recorded as blocked requests, not as page errors.
    page.on("console", message => { if (message.type() === "error" && !/ERR_BLOCKED_BY_CLIENT/.test(message.text())) consoleErrors.push(message.text()); });
    page.on("pageerror", error => consoleErrors.push(`Uncaught: ${error.message}`));
    page.on("requestfailed", request => { const reason = request.failure()?.errorText ?? "failed"; if (!/ERR_BLOCKED_BY_CLIENT|NS_ERROR_ABORT|cancelled/i.test(reason)) failedRequests.push(`${request.method()} ${request.url()}: ${reason}`); });

    const response = await page.goto(url.href, { waitUntil: "load" });
    if (!allowed.has(new URL(page.url()).origin)) throw new Error("Navigation redirect left the allowed origins");
    if (response && response.status() >= 400) failures.push(`HTTP ${response.status()} for ${url.pathname}${url.search}`);

    switch (testCase.category) {
      case "functional": {
        const visible = await page.getByRole("heading").first().waitFor({ state: "visible" }).then(() => true, () => false);
        if (!visible) failures.push("No visible heading");
        if (policy.failOnConsoleErrors && consoleErrors.length) failures.push(`${consoleErrors.length} console error(s): ${redact(consoleErrors[0]).slice(0, 200)}`);
        const sameOriginFailures = failedRequests.filter(item => { try { return allowed.has(new URL(item.split(" ")[1]).origin); } catch { return false; } });
        if (sameOriginFailures.length) failures.push(`${sameOriginFailures.length} same-origin request(s) failed`);
        break;
      }
      case "accessibility": {
        const result = await new AxeBuilder({ page }).analyze();
        const path = join(dir, "accessibility.json");
        await writeFile(path, JSON.stringify({ url: result.url, violations: result.violations, incomplete: result.incomplete.map(item => ({ id: item.id, impact: item.impact, help: item.help })) }, null, 2));
        evidence.push({ id: randomUUID(), kind: "accessibility", path, description: `${result.violations.length} axe violation(s)` });
        const blocking = result.violations.filter(item => IMPACT_RANK[(item.impact ?? "minor") as Impact] >= IMPACT_RANK[policy.accessibilityFailOn]);
        if (blocking.length) failures.push(`Accessibility violations at or above "${policy.accessibilityFailOn}": ${blocking.map(item => `${item.id} (${item.impact}, ${item.nodes.length} node(s))`).join(", ")}`);
        break;
      }
      case "responsive": {
        const widths = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: window.innerWidth }));
        if (widths.document > widths.viewport) failures.push(`Horizontal overflow: document is ${widths.document}px wide in a ${widths.viewport}px viewport`);
        break;
      }
      case "journey": {
        try { await runActions(page, testCase.actions ?? [], { baseUrl: target.baseUrl, allowedOrigins: allowed, timeoutMs: target.actionTimeoutMs }); }
        catch (error) {
          if (error instanceof MissingSecretError) throw new BlockedError(error.message);
          failures.push(redact(error instanceof Error ? error.message : String(error)));
        }
        if (policy.failOnConsoleErrors && consoleErrors.length) failures.push(`${consoleErrors.length} console error(s): ${redact(consoleErrors[0]).slice(0, 200)}`);
        break;
      }
      case "ui":
        break;
      default:
        await finishScreenshot(page);
        return finish("inconclusive", `No automated check exists for category "${testCase.category}"`);
    }

    const screenshot = await finishScreenshot(page);
    if (testCase.category === "ui") await compareWithBaseline(screenshot);
    return failures.length ? finish("failed", failures.join("; ")) : finish("passed");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof BlockedError) return finish("blocked", message);
    return finish(INFRASTRUCTURE_ERROR.test(message) ? "infrastructure_failure" : "failed", [...failures, message].join("; "));
  }

  async function finishScreenshot(page: Page) {
    const path = join(dir, "page.png");
    await page.screenshot({ path, fullPage: true, animations: "disabled", caret: "hide", mask: policy.maskSelectors.map(selector => page.locator(selector)) });
    evidence.push({ id: randomUUID(), kind: "screenshot", path, description: "Full page after load" });
    return path;
  }

  async function compareWithBaseline(screenshot: string) {
    const baseline = baselineFile(target, testCase);
    let expectedBytes: Buffer;
    try { expectedBytes = await readFile(baseline); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new BlockedError(`Missing visual baseline for ${testCase.id} (${target.viewportProfileName ?? "default"}); approve one with "testswarm baseline <run-id>"`);
      throw error;
    }
    const actual = PNG.sync.read(await readFile(screenshot)), expected = PNG.sync.read(expectedBytes);
    if (actual.width !== expected.width || actual.height !== expected.height) {
      failures.push(`Visual size changed from ${expected.width}x${expected.height} to ${actual.width}x${actual.height}`);
      return;
    }
    const diff = new PNG({ width: actual.width, height: actual.height });
    const changed = pixelmatch(actual.data, expected.data, diff.data, actual.width, actual.height, { threshold: 0.1 });
    const ratio = changed / (actual.width * actual.height);
    if (ratio > policy.visualMaxDiffRatio) {
      const diffPath = join(dir, "visual-diff.png"), expectedPath = join(dir, "visual-expected.png");
      await writeFile(diffPath, PNG.sync.write(diff));
      await copyFile(baseline, expectedPath);
      evidence.push({ id: randomUUID(), kind: "screenshot", path: expectedPath, description: "Approved visual baseline" }, { id: randomUUID(), kind: "screenshot", path: diffPath, description: `Visual diff (${changed} pixels changed)` });
      failures.push(`Visual mismatch: ${(ratio * 100).toFixed(3)}% of pixels changed (limit ${(policy.visualMaxDiffRatio * 100).toFixed(3)}%)`);
    }
  }
}

/** Retries failed or infrastructure-failed cases; a case that passes after a retry is reported as flaky. */
export async function executeCaseWithRetry(target: ApplicationTarget, testCase: TestCase, artifactsDir: string, retries = 0, options: ExecutionOptions = {}): Promise<TestExecution> {
  let last: TestExecution | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    last = await executeCase(target, testCase, join(artifactsDir, `attempt-${attempt + 1}`), options);
    if (last.outcome === "passed") return attempt === 0 ? last : { ...last, outcome: "flaky", error: `Passed after ${attempt} retry attempt(s)` };
    if (!["failed", "infrastructure_failure"].includes(last.outcome)) return last;
  }
  return last!;
}
