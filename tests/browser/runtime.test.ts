import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationTarget, TestCase } from "../../src/core/contracts.js";
import { baselineFile, executeCase, executeCaseWithRetry } from "../../src/browser-runtime/runner.js";
import { close, listen } from "../helpers.js";

const html = (body: string, head = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title>${head}</head><body><main>${body}</main></body></html>`;
const pages: Record<string, string> = {
  "/": html("<h1>Home</h1><p>ok</p>"),
  "/no-heading": html("<p>nothing</p>"),
  "/console": html("<h1>Console</h1><script>console.error('boom token=abc123')</script>"),
  "/external": html('<h1>External</h1><img alt="" src="https://example.invalid/pixel.png">'),
  "/unlabelled": html('<h1>Form</h1><input type="text">'),
  "/wide": html('<h1>Wide</h1><div style="width:3000px;height:10px"></div>'),
  "/blue": html("<h1>Colour</h1>", "<style>body{background:#00f}</style>"),
  "/red": html("<h1>Colour</h1>", "<style>body{background:#f00}</style>")
};
const server = createServer((request, response) => { const body = pages[request.url ?? "/"]; response.writeHead(body ? 200 : 404, { "content-type": "text/html" }); response.end(body ?? html("<h1>Not found</h1>")); });
let baseUrl = "";
test.before(async () => { baseUrl = await listen(server); });
test.after(() => close(server));

const target = (extra: Partial<ApplicationTarget> = {}) => ApplicationTarget.parse({ baseUrl, allowedOrigins: [baseUrl], startPath: "/", actionTimeoutMs: 2000, viewport: { width: 800, height: 600 }, ...extra });
const testCase = (path: string, category: TestCase["category"], extra: Partial<TestCase> = {}): TestCase => ({ id: `case-${category}`, title: path, feature: path, category, priority: "low", preconditions: [], steps: [`Navigate to ${path}`], assertions: ["x"], expectedOutcome: "x", requiredEvidence: [], timeoutMs: 10000, destructive: "none", ...extra });
const artifacts = () => mkdtemp(join(tmpdir(), "testswarm-run-"));
const options = { policy: { trace: "off" as const } };

test("browser launch failures are infrastructure failures", async () => {
  const result = await executeCase(target({ executablePath: join(tmpdir(), "does-not-exist", "browser") }), testCase("/", "functional"), await artifacts(), options);
  assert.equal(result.outcome, "infrastructure_failure");
});

test("a browser disconnected immediately after launch is an infrastructure failure", async () => {
  const result = await executeCase(target(), testCase("/", "functional"), await artifacts(), { ...options, hooks: { afterLaunch: browser => browser.close() } });
  assert.equal(result.outcome, "infrastructure_failure", result.error);
});

test("functional checks pass on a healthy page and fail on HTTP errors, missing headings, and console errors", async () => {
  assert.equal((await executeCase(target(), testCase("/", "functional"), await artifacts(), options)).outcome, "passed");
  const missing = await executeCase(target(), testCase("/missing", "functional"), await artifacts(), options);
  assert.equal(missing.outcome, "failed");
  assert.match(missing.error!, /HTTP 404/);
  assert.match((await executeCase(target(), testCase("/no-heading", "functional"), await artifacts(), options)).error!, /No visible heading/);
  const consoleRun = await executeCase(target(), testCase("/console", "functional"), await artifacts(), options);
  assert.equal(consoleRun.outcome, "failed");
  assert.equal(consoleRun.error!.includes("abc123"), false, "console text in errors is redacted");
  assert.equal((await executeCase(target(), testCase("/console", "functional"), await artifacts(), { policy: { trace: "off", failOnConsoleErrors: false } })).outcome, "passed");
});

test("third-party requests are blocked and recorded unless policy allows them", async () => {
  const result = await executeCase(target(), testCase("/external", "functional"), await artifacts(), options);
  assert.equal(result.outcome, "passed", result.error);
  assert.ok(result.evidence.some(item => item.kind === "network" && /1 policy-blocked/.test(item.description)));
});

test("accessibility cases fail on violations at or above the threshold", async () => {
  assert.equal((await executeCase(target(), testCase("/", "accessibility"), await artifacts(), options)).outcome, "passed");
  const result = await executeCase(target(), testCase("/unlabelled", "accessibility"), await artifacts(), options);
  assert.equal(result.outcome, "failed");
  assert.match(result.error!, /label/);
  assert.equal((await executeCase(target(), testCase("/unlabelled", "accessibility"), await artifacts(), { policy: { trace: "off", accessibilityFailOn: "critical" } })).outcome, "failed", "missing label is critical");
});

test("responsive cases fail on horizontal overflow", async () => {
  assert.equal((await executeCase(target(), testCase("/", "responsive"), await artifacts(), options)).outcome, "passed");
  assert.match((await executeCase(target(), testCase("/wide", "responsive"), await artifacts(), options)).error!, /Horizontal overflow/);
});

test("visual cases are blocked without a baseline, pass on a match, and fail with a diff on a change", async () => {
  const baselines = await artifacts();
  const t = target({ visualBaselinesDir: baselines, viewportProfileName: "desktop" });
  const blue = testCase("/blue", "ui");
  const first = await executeCase(t, blue, await artifacts(), options);
  assert.equal(first.outcome, "blocked");
  const screenshot = first.evidence.find(item => item.kind === "screenshot")!.path;
  await copyFile(screenshot, baselineFile(t, blue));
  assert.equal((await executeCase(t, blue, await artifacts(), options)).outcome, "passed");
  const changed = await executeCase(t, { ...blue, steps: ["Navigate to /red"] }, await artifacts(), options);
  assert.equal(changed.outcome, "failed");
  assert.match(changed.error!, /Visual mismatch/);
  assert.ok(changed.evidence.some(item => item.path.endsWith("visual-diff.png")));
});

test("destructive cases are blocked unless policy allows them", async () => {
  const result = await executeCase(target(), testCase("/", "functional", { destructive: "destructive" }), await artifacts(), options);
  assert.equal(result.outcome, "blocked");
});

test("traces are retained for failures only by default", async () => {
  const failed = await executeCase(target(), testCase("/no-heading", "functional"), await artifacts());
  assert.ok(failed.evidence.some(item => item.kind === "trace"));
  const passed = await executeCase(target(), testCase("/", "functional"), await artifacts());
  assert.equal(passed.evidence.some(item => item.kind === "trace"), false);
});

test("retries do not repeat blocked cases", async () => {
  const result = await executeCaseWithRetry(target(), testCase("/", "functional", { destructive: "reversible" }), await artifacts(), 2, options);
  assert.equal(result.outcome, "blocked");
});

test("unsupported categories are inconclusive rather than passed", async () => {
  assert.equal((await executeCase(target(), testCase("/", "performance"), await artifacts(), options)).outcome, "inconclusive");
});
