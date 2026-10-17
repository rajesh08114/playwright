import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PNG } from "pngjs";
import { close, listen } from "../helpers.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Starts the server exactly as .mcp.json does (through the launcher), from a temp project with no config.
const launcher = fileURLToPath(new URL("../../../scripts/mcp.mjs", import.meta.url));
const { createDemoServer } = await import(new URL("../../../fixtures/demo-app/app.mjs", import.meta.url).href) as { createDemoServer(): Server };

type Result = Awaited<ReturnType<Client["callTool"]>>;
const text = (result: Result) => (result.content as Array<{ type: string; text?: string }>).find(item => item.type === "text")?.text ?? "";
const json = (result: Result) => JSON.parse(text(result));

async function connect(projectDir: string) {
  const env = { ...process.env, TESTSWARM_PROJECT_DIR: projectDir } as Record<string, string>;
  const client = new Client({ name: "e2e", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [launcher], env, stderr: "pipe" }));
  return client;
}

async function waitForRun(client: Client, runId: string) {
  for (let attempt = 0; attempt < 240; attempt++) {
    const status = json(await client.callTool({ name: "testswarm_status", arguments: { runId } }));
    if (status.status !== "running") return status;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`run ${runId} did not finish`);
}

test("MCP end to end: setup, plan, run, inspect, see screenshots, approve baselines, go green", async () => {
  const server = createDemoServer();
  const baseUrl = await listen(server);
  const project = await mkdtemp(join(tmpdir(), "testswarm-mcp-"));
  const client = await connect(project);
  try {
    const { tools } = await client.listTools();
    for (const name of ["testswarm_doctor", "testswarm_install_browser", "testswarm_run", "testswarm_status", "testswarm_results", "testswarm_screenshot", "testswarm_baseline", "testswarm_login", "testswarm_plan_with_ai", "testswarm_plan_with_agent"]) assert.ok(tools.some(item => item.name === name), name);
    assert.equal(tools.find(item => item.name === "testswarm_status")?.annotations?.readOnlyHint, true);

    // No config yet: doctor says so, init fixes it.
    const before = json(await client.callTool({ name: "testswarm_doctor", arguments: {} }));
    assert.equal(before.checks.find((check: { name: string }) => check.name === "configuration").status, "failed");
    assert.equal(json(await client.callTool({ name: "testswarm_init", arguments: { baseUrl } })).created, true);
    const doctor = json(await client.callTool({ name: "testswarm_doctor", arguments: {} }));
    assert.equal(doctor.ok, true, JSON.stringify(doctor.checks));
    assert.ok(doctor.checks.some((check: { name: string; status: string }) => check.name === "browser" && check.status !== "failed"));

    // Planning returns a compact summary, not the whole plan.
    const planned = await client.callTool({ name: "testswarm_plan_from_discovery", arguments: {} });
    const plan = json(planned);
    assert.ok(text(planned).length < 3000, `plan response is ${text(planned).length} chars`);
    assert.deepEqual([...plan.routes].sort(), ["/", "/login", "/products", "/search"]);
    assert.equal(plan.byCategory.ui, 4);
    assert.equal(json(await client.callTool({ name: "testswarm_get_plan", arguments: { planId: plan.planId } })).cases.length, plan.cases);

    // First run: nothing fails, visual checks wait for approval, and the response says what to do next.
    const run = json(await client.callTool({ name: "testswarm_run", arguments: { planId: plan.planId } }));
    assert.equal(run.status, "running");
    const first = await waitForRun(client, run.runId);
    assert.equal(first.status, "blocked", JSON.stringify(first));
    assert.equal(first.summary.failed, 0);
    assert.ok(first.nextSteps.some((step: string) => /no approved baseline/.test(step)), first.nextSteps.join(" | "));

    const results = await client.callTool({ name: "testswarm_results", arguments: { runId: run.runId } });
    const view = json(results);
    assert.ok(view.executions.every((item: { outcome: string }) => item.outcome === "blocked"), "only non-passing executions are listed by default");
    assert.ok(text(results).length < 6000, `results response is ${text(results).length} chars`);

    // The assistant can look at the page.
    const shot = await client.callTool({ name: "testswarm_screenshot", arguments: { runId: run.runId, testCaseId: "TS-UI-products", viewport: "mobile" } });
    const image = (shot.content as Array<{ type: string; data?: string; mimeType?: string }>).find(item => item.type === "image")!;
    assert.equal(image.mimeType, "image/png");
    const png = PNG.sync.read(Buffer.from(image.data!, "base64"));
    assert.equal(png.width, 390, "mobile viewport width");
    assert.match(text(shot), /TS-UI-products at mobile: blocked/);

    // Approve after review, run again: green.
    assert.equal(json(await client.callTool({ name: "testswarm_baseline", arguments: { runId: run.runId } })).files.length, 8);
    const second = json(await client.callTool({ name: "testswarm_run", arguments: { planId: plan.planId, wait: true } }));
    assert.equal(second.status, "completed", JSON.stringify(second));
    assert.deepEqual(second.nextSteps, ["Everything passed."]);

    const report = json(await client.callTool({ name: "testswarm_report", arguments: { runId: second.runId } }));
    await access(report.files.html);
    assert.equal(report.summary.passed, 32);
    const evidence = json(await client.callTool({ name: "testswarm_evidence", arguments: { runId: second.runId, testCaseId: "TS-A11Y-root", kind: "accessibility" } }));
    assert.equal(evidence.total, 2);

    // Errors come back as tool errors with a readable message.
    const missing = await client.callTool({ name: "testswarm_screenshot", arguments: { runId: second.runId, testCaseId: "TS-NOPE" } });
    assert.equal(missing.isError, true);
    assert.match(text(missing), /No execution of TS-NOPE/);
    const unknown = await client.callTool({ name: "testswarm_status", arguments: { runId: "nope" } });
    assert.equal(unknown.isError, true);
    assert.match(text(unknown), /Run not found/);
  } finally {
    await client.close();
    await close(server);
  }
});
