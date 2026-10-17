#!/usr/bin/env node
import "../core/quiet-warnings.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Engine } from "../core/engine.js";
import { VERSION } from "../core/version.js";

// The project directory is TESTSWARM_PROJECT_DIR when set, otherwise the directory the host launched the server in.
const engine = new Engine();
const server = new McpServer({ name: "testswarm", version: VERSION }, {
  instructions: "TestSwarm runs deterministic browser checks (functional, accessibility, responsive, visual) against the target in the project's testswarm.config.json. Typical flow: testswarm_doctor -> testswarm_plan_from_discovery -> testswarm_run (returns a runId immediately) -> poll testswarm_status until status is not \"running\" -> testswarm_report / testswarm_verify. UI cases stay \"blocked\" until a human approves baselines with testswarm_baseline. Findings are observations to verify, not confirmed defects."
});

type Annotations = { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
const READ: Annotations = { readOnlyHint: true, openWorldHint: false };
const BROWSER: Annotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const WRITE: Annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function tool<Shape extends z.ZodRawShape>(name: string, description: string, inputSchema: Shape, annotations: Annotations, handler: (input: z.objectOutputType<Shape, z.ZodTypeAny>) => Promise<unknown>) {
  server.registerTool(name, { description, inputSchema, annotations }, (async (input: z.objectOutputType<Shape, z.ZodTypeAny>) => {
    try {
      const result = await handler(input);
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

tool("testswarm_doctor", "Run preflight checks: Node version, configuration, storage, browser launch, and target reachability", {}, READ, () => engine.doctor());
tool("testswarm_project_inspect", "Show the validated project configuration", {}, READ, () => engine.inspect());
tool("testswarm_init", "Create a starter testswarm.config.json in the project if none exists", { baseUrl: z.string().url().optional().describe("Origin of the application under test") }, WRITE, ({ baseUrl }) => engine.init(baseUrl));
tool("testswarm_discover", "Crawl same-origin routes from the start path, target.routes, and sitemap.xml (no form submission)", {}, BROWSER, () => engine.discover());
tool("testswarm_plan", "Create a plan from target.startPath and target.routes without crawling", {}, WRITE, () => engine.plan());
tool("testswarm_plan_from_discovery", "Crawl the target and create a reviewable plan from the observed routes", {}, BROWSER, () => engine.planFromDiscovery());
tool("testswarm_run", "Execute a stored plan. Returns the run immediately; poll testswarm_status for progress", { planId, wait }, BROWSER, async ({ planId, wait }) => {
  const { run, done } = await engine.start(planId);
  if (wait) return done;
  done.catch(() => undefined);
  return { runId: run.id, status: run.status, expectedExecutions: run.expectedExecutions, next: "Poll testswarm_status with this runId" };
});
tool("testswarm_status", "Progress and outcome counts for a run", { runId }, READ, ({ runId }) => engine.progress(runId));
tool("testswarm_list_runs", "List recent runs with outcome counts", { limit: z.number().int().min(1).max(100).optional() }, READ, ({ limit }) => engine.runs(limit));
tool("testswarm_results", "Full run record including every execution", { runId }, READ, ({ runId }) => engine.results(runId));
tool("testswarm_evidence", "List evidence files (screenshots, traces, axe results, console and network logs) for a run", { runId }, READ, ({ runId }) => engine.evidence(runId));
tool("testswarm_report", "Write JSON, HTML, and JUnit reports for a run and return their paths", { runId }, WRITE, ({ runId }) => engine.report(runId));
tool("testswarm_verify", "Group failed executions into findings with confidence and reproduction steps", { runId }, READ, ({ runId }) => engine.verify(runId));
tool("testswarm_cancel", "Cancel a running run (also stops runs executing in other processes before their next case)", { runId }, { ...WRITE, destructiveHint: true }, ({ runId }) => engine.cancel(runId));
tool("testswarm_retest", "Re-run only the cases that did not pass in a run, as a new run", { runId, wait }, BROWSER, async ({ runId, wait }) => {
  const { run, done } = await engine.startRetest(runId);
  if (wait) return done;
  done.catch(() => undefined);
  return { runId: run.id, retestOf: runId, status: run.status, expectedExecutions: run.expectedExecutions, next: "Poll testswarm_status with this runId" };
});
tool("testswarm_resume", "Continue an interrupted or failed run in place", { runId, force: z.boolean().optional().describe("Resume a run still marked running whose process has exited"), wait }, BROWSER, async ({ runId, force, wait }) => {
  const { done } = await engine.startResume(runId, { force });
  if (wait) return done;
  done.catch(() => undefined);
  return engine.progress(runId);
});
tool("testswarm_repeat", "Run a plan several times and report cases whose outcome changed between runs", { planId, count: z.number().int().min(2).max(10).optional() }, BROWSER, ({ planId, count }) => engine.repeat(planId, count ?? 2));
tool("testswarm_export", "Write the plan as a standalone @playwright/test spec file", { planId }, WRITE, ({ planId }) => engine.exportPlan(planId));
tool("testswarm_benchmark", "Measure case coverage, outcomes, and seeded-defect recall for a run", { runId }, WRITE, ({ runId }) => engine.benchmark(runId));
tool("testswarm_compare", "Compare outcome counts between two runs", { firstRunId: runId, secondRunId: runId }, READ, ({ firstRunId, secondRunId }) => engine.compare(firstRunId, secondRunId));
tool("testswarm_agents", "Run the scoped specialist agents for a plan without persisting a run", { planId }, BROWSER, ({ planId }) => engine.agents(planId));
tool("testswarm_agent_run", "Run the specialist agents and persist the result as a comparable run", { planId }, BROWSER, ({ planId }) => engine.agentRun(planId));
tool("testswarm_baseline", "Approve a run's UI screenshots as visual baselines. Only call this after a human has reviewed the screenshots", { runId, caseIds: z.array(z.string()).optional().describe("Approve only these UI case ids") }, { ...WRITE, destructiveHint: true }, ({ runId, caseIds }) => engine.baseline(runId, caseIds));

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
