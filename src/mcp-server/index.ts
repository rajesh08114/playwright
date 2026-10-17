#!/usr/bin/env node
import "../core/quiet-warnings.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Engine, latestExecutions } from "../core/engine.js";
import { VERSION } from "../core/version.js";
import { installBrowser } from "../browser-runtime/browsers.js";
import { planView, runView, screenshotImage } from "./views.js";

// The project directory is TESTSWARM_PROJECT_DIR when set, otherwise the directory the host launched the server in.
const engine = new Engine();
const server = new McpServer({ name: "testswarm", version: VERSION }, {
  instructions: [
    "TestSwarm runs deterministic browser checks (functional, accessibility, responsive, visual, and user journeys) against the target in the project's testswarm.config.json.",
    "Flow: testswarm_doctor (fix anything it reports; testswarm_install_browser if no browser starts) -> testswarm_plan_from_discovery -> testswarm_run (returns a runId immediately) -> poll testswarm_status until status is not \"running\" -> testswarm_results for what did not pass -> testswarm_screenshot to look at a page.",
    "Status \"blocked\" means nothing failed but some cases need a person: usually visual checks without an approved baseline. Show the user the screenshots and only call testswarm_baseline after they confirm they look right.",
    "Findings are observations to verify, not confirmed defects."
  ].join(" ")
});

type Annotations = { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
const READ: Annotations = { readOnlyHint: true, openWorldHint: false };
const BROWSER: Annotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const WRITE: Annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
type Content = Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
/** Handlers return plain data (sent as JSON text) or this wrapper to send content blocks such as images directly. */
class Raw { constructor(readonly content: Content) {} }

function tool<Shape extends z.ZodRawShape>(name: string, description: string, inputSchema: Shape, annotations: Annotations, handler: (input: z.objectOutputType<Shape, z.ZodTypeAny>) => Promise<unknown>) {
  server.registerTool(name, { description, inputSchema, annotations }, (async (input: z.objectOutputType<Shape, z.ZodTypeAny>) => {
    try {
      const result = await handler(input);
      if (result instanceof Raw) return { content: result.content };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const err = error as Error;
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: err?.name ?? "Error", message: err?.message ?? String(error) }) }] };
    }
  }) as never);
}

const runId = z.string().min(1).describe("Run id returned by testswarm_run");
const planId = z.string().min(1).describe("Plan id returned by a planning tool");
const wait = z.boolean().optional().describe("Wait for the run to finish instead of returning immediately (may exceed client timeouts on large plans)");
const started = (run: { id: string; status: string; expectedExecutions?: number }, extra: Record<string, unknown> = {}) => ({ runId: run.id, status: run.status, expectedExecutions: run.expectedExecutions, ...extra, next: `Poll testswarm_status with runId ${run.id} every few seconds until status is not "running".` });

// Setup
tool("testswarm_doctor", "Run preflight checks: Node version, configuration, storage, which browser starts, and target reachability. Start here", {}, READ, () => engine.doctor());
tool("testswarm_install_browser", "Download the browser build this TestSwarm version expects (about 150 MB, needs internet). Use when testswarm_doctor reports that no browser starts or that a fallback browser is in use", {}, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }, async () => {
  const config = await engine.config().catch(() => undefined);
  const browser = config?.target.browser ?? "chromium";
  const code = await installBrowser(browser);
  if (code !== 0) throw new Error(`Browser download failed (exit code ${code}). On Linux, system libraries may be missing: run "npx playwright install --with-deps ${browser}" in a terminal.`);
  return { installed: browser, next: "Run testswarm_doctor to confirm." };
});
tool("testswarm_project_inspect", "Show the validated project configuration", {}, READ, () => engine.inspect());
tool("testswarm_init", "Create a starter testswarm.config.json in the project if none exists", { baseUrl: z.string().url().optional().describe("Origin of the application under test, e.g. http://localhost:3000") }, WRITE, ({ baseUrl }) => engine.init(baseUrl));
tool("testswarm_login", "Run the configured scripted login and save the browser session for later runs", {}, BROWSER, () => engine.login());

// Planning
tool("testswarm_discover", "Crawl same-origin routes from the start path, target.routes, and sitemap.xml (no form submission)", {}, BROWSER, async () => {
  const result = await engine.discover();
  return { routes: result.routes.map(route => ({ path: route.path, heading: route.heading ?? route.title, forms: route.forms, interactiveElements: route.interactiveElements })), warnings: result.warnings };
});
tool("testswarm_plan", "Create a plan from target.startPath, target.routes, and configured journeys without crawling", {}, WRITE, async () => planView(await engine.plan()));
tool("testswarm_plan_from_discovery", "Crawl the target and create a plan from the observed routes plus configured journeys", {}, BROWSER, async () => planView(await engine.planFromDiscovery()));
tool("testswarm_plan_with_ai", "Crawl the target, send redacted accessibility snapshots to the configured model (Anthropic), and create a plan that adds validated model-proposed user journeys. Requires llm.enabled. Journeys that type or submit stay blocked until a human reviews them", {}, BROWSER, async () => {
  const { plan, ...rest } = await engine.planWithAi();
  return { ...planView(plan), ...rest };
});
tool("testswarm_plan_with_agent", "Let a LangGraph deep agent explore the target route by route, run candidate journeys in the browser, fix failures, and add only verified journeys to a new plan. Requires llm.enabled; sends page snapshots to Anthropic and can take several minutes. Also reports candidate defects", {}, BROWSER, async () => {
  const { plan, ...rest } = await engine.planWithAgent();
  return { ...planView(plan), ...rest };
});
tool("testswarm_get_plan", "Every case in a plan, with steps and assertions", { planId }, READ, ({ planId }) => engine.getPlan(planId));

// Running
tool("testswarm_run", "Execute a stored plan. Returns the run immediately; poll testswarm_status for progress", { planId, wait }, BROWSER, async ({ planId, wait }) => {
  const { run, done } = await engine.start(planId);
  if (wait) return runView(await done);
  done.catch(() => undefined);
  return started(run);
});
tool("testswarm_status", "Progress, outcome counts, and next steps for a run", { runId }, READ, ({ runId }) => engine.progress(runId));
tool("testswarm_retest", "Re-run only the cases that did not pass in a run, as a new run", { runId, wait }, BROWSER, async ({ runId, wait }) => {
  const { run, done } = await engine.startRetest(runId);
  if (wait) return runView(await done);
  done.catch(() => undefined);
  return started(run, { retestOf: runId });
});
tool("testswarm_resume", "Continue an interrupted, failed, blocked, or stale run in place", { runId, force: z.boolean().optional().describe("Resume a run still marked running whose process has exited"), wait }, BROWSER, async ({ runId, force, wait }) => {
  const { run, done } = await engine.startResume(runId, { force });
  if (wait) return runView(await done);
  done.catch(() => undefined);
  return started(run);
});
tool("testswarm_cancel", "Cancel a running run (also stops runs executing in other processes before their next case)", { runId }, { ...WRITE, destructiveHint: true }, async ({ runId }) => { const run = await engine.cancel(runId); return { runId: run.id, status: run.status }; });
tool("testswarm_repeat", "Run a plan several times and report cases whose outcome changed between runs", { planId, count: z.number().int().min(2).max(10).optional() }, BROWSER, ({ planId, count }) => engine.repeat(planId, count ?? 2));
tool("testswarm_list_runs", "List recent runs with outcome counts", { limit: z.number().int().min(1).max(100).optional() }, READ, ({ limit }) => engine.runs(limit));

// Results
tool("testswarm_results", "What happened in a run: counts, next steps, and every execution that did not pass (errors included)", {
  runId,
  includePassed: z.boolean().optional().describe("Also list passed executions"),
  limit: z.number().int().min(1).max(1000).optional().describe("Maximum executions to list (default 50)")
}, READ, async ({ runId, includePassed, limit }) => runView(await engine.results(runId), { includePassed, limit }));
tool("testswarm_screenshot", "Show the screenshot TestSwarm took for a case in a run, so you can see what the page looked like. Very tall pages are cropped to the top", {
  runId,
  testCaseId: z.string().min(1).describe("Case id, e.g. TS-FUNC-root"),
  viewport: z.string().optional().describe("Viewport profile name, e.g. mobile or desktop; defaults to the first one"),
  kind: z.enum(["page", "diff", "baseline"]).optional().describe("page (default), or for failed visual checks the diff image or the approved baseline")
}, READ, async ({ runId, testCaseId, viewport, kind }) => {
  const run = await engine.results(runId);
  const candidates = latestExecutions(run).filter(item => item.testCaseId === testCaseId && (!viewport || item.viewportProfile === viewport));
  if (!candidates.length) throw new Error(`No execution of ${testCaseId}${viewport ? ` at ${viewport}` : ""} in run ${runId}. Viewports in this run: ${[...new Set(run.executions.map(item => item.viewportProfile))].join(", ")}`);
  const execution = candidates[0];
  const file = { page: "page.png", diff: "visual-diff.png", baseline: "visual-expected.png" }[kind ?? "page"];
  const shot = execution.evidence.find(item => item.kind === "screenshot" && item.path.endsWith(file));
  if (!shot) throw new Error(`No ${kind ?? "page"} screenshot for ${testCaseId} (${execution.viewportProfile}); outcome was ${execution.outcome}${execution.error ? `: ${execution.error}` : ""}`);
  const image = await screenshotImage(shot.path);
  return new Raw([
    { type: "text", text: `${testCaseId} at ${execution.viewportProfile ?? "default"}: ${execution.outcome}${execution.error ? ` (${execution.error.slice(0, 300)})` : ""}${image.note ? `\n${image.note}` : ""}` },
    { type: "image", data: image.data, mimeType: "image/png" }
  ]);
});
tool("testswarm_evidence", "List evidence files (screenshots, traces, axe results, console and network logs) for a run", {
  runId,
  testCaseId: z.string().optional().describe("Only this case"),
  kind: z.enum(["screenshot", "trace", "console", "network", "accessibility", "json"]).optional(),
  limit: z.number().int().min(1).max(1000).optional().describe("Maximum items (default 50)")
}, READ, async ({ runId, testCaseId, kind, limit }) => {
  const items = (await engine.evidence(runId)).filter(item => (!testCaseId || item.testCaseId === testCaseId) && (!kind || item.kind === kind));
  const max = limit ?? 50;
  return { total: items.length, items: items.slice(0, max).map(item => ({ testCaseId: item.testCaseId, viewport: item.viewportProfile, kind: item.kind, description: item.description, path: item.path })) };
});
tool("testswarm_report", "Write JSON, HTML, and JUnit reports for a run; returns their paths and a summary", { runId }, WRITE, async ({ runId }) => {
  const { report, files } = await engine.report(runId);
  return { files, summary: report.summary, findings: report.findings.length, next: "Open files.html in a browser, or use testswarm_results / testswarm_screenshot here." };
});
tool("testswarm_verify", "Group failed executions into findings with confidence and reproduction steps", { runId }, READ, ({ runId }) => engine.verify(runId));
tool("testswarm_baseline", "Approve a run's UI screenshots as visual baselines. Only call this after the user has looked at the screenshots and confirmed they are correct", { runId, caseIds: z.array(z.string()).optional().describe("Approve only these UI case ids") }, { ...WRITE, destructiveHint: true }, ({ runId, caseIds }) => engine.baseline(runId, caseIds));
tool("testswarm_export", "Write the plan as a standalone @playwright/test spec file", { planId }, WRITE, ({ planId }) => engine.exportPlan(planId));
tool("testswarm_benchmark", "Measure case coverage, outcomes, and seeded-defect recall for a run", { runId }, WRITE, ({ runId }) => engine.benchmark(runId));
tool("testswarm_compare", "Compare outcome counts between two runs", { firstRunId: runId, secondRunId: runId }, READ, ({ firstRunId, secondRunId }) => engine.compare(firstRunId, secondRunId));
tool("testswarm_agents", "Run the scoped specialist agents for a plan without persisting a run", { planId }, BROWSER, async ({ planId }) => { const result = await engine.agents(planId); return { agents: result.agents, executions: result.executions.length, notPassed: result.executions.filter(item => item.outcome !== "passed").map(item => ({ testCaseId: item.testCaseId, viewport: item.viewportProfile, outcome: item.outcome, error: item.error })) }; });
tool("testswarm_agent_run", "Run the specialist agents and persist the result as a comparable run", { planId }, BROWSER, async ({ planId }) => { const result = await engine.agentRun(planId); return { agents: result.agents, ...runView(result.run) }; });

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await engine.shutdown().catch(() => undefined);
  await server.close().catch(() => undefined);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);

await server.connect(new StdioServerTransport());
