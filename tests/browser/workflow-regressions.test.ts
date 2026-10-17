import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Engine } from "../../src/core/engine.js";
import type { JourneyProposer, PageSnapshot } from "../../src/llm/provider.js";
import { close, listen, targetFor, tempProject } from "../helpers.js";

// Each test reproduces a bug found by walking the end-to-end workflow; see CHANGELOG "Fixed".
const { createDemoServer, DEMO_USER } = await import(new URL("../../../fixtures/demo-app/app.mjs", import.meta.url).href) as { createDemoServer(): Server; DEMO_USER: { email: string; password: string } };
const cli = fileURLToPath(new URL("../../src/cli/index.js", import.meta.url));
const unusedPort = async () => { const server = createDemoServer(); const url = await listen(server); await close(server); return url; };
const policy = { trace: "off" };

test("an unreachable target never produces an empty, passing plan", async () => {
  const baseUrl = await unusedPort();
  const engine = new Engine({ projectDir: await tempProject({ target: targetFor(baseUrl), policy }) });
  try {
    await assert.rejects(() => engine.planFromDiscovery(), /Discovery found no pages .*Is the application running\?/);
    const plan = await engine.plan(); // explicit routes still plan, and running them reports the environment, not app bugs
    const run = await engine.run(plan.id);
    assert.equal(run.status, "failed");
    assert.ok(run.executions.every(item => item.outcome === "infrastructure_failure"), JSON.stringify(run.executions.map(item => item.outcome)));
    assert.match(run.executions[0].error!, /^Target not reachable: .*ERR_CONNECTION_REFUSED/);
    assert.doesNotMatch(run.executions[0].error!, /Call log/);
  } finally { engine.close(); }
});

test("a plan with no cases cannot be run", async () => {
  const engine = new Engine({ projectDir: await tempProject({ target: targetFor("http://127.0.0.1:3999"), budgets: { maxCases: 1 }, policy }) });
  try {
    const plan = await engine.plan();
    const store = (engine as unknown as { store(): Promise<{ putPlan(plan: unknown): Promise<void> }> });
    await (await store.store()).putPlan({ ...plan, cases: [] });
    await assert.rejects(() => engine.run(plan.id), /has no cases to run/);
  } finally { engine.close(); }
});

const authConfig = { loginPath: "/login", successPath: "/account", steps: [
  { type: "fill", target: { label: "Email" }, value: DEMO_USER.email },
  { type: "fill", target: { label: "Password" }, valueFromEnv: "TESTSWARM_REGRESSION_PASSWORD" },
  { type: "click", target: { role: "button", name: "Sign in" } }
] };

test("a saved session the server has dropped is replaced instead of running everything logged out", async () => {
  process.env.TESTSWARM_REGRESSION_PASSWORD = DEMO_USER.password;
  let server = createDemoServer();
  const baseUrl = await listen(server);
  const port = Number(new URL(baseUrl).port);
  const journeys = [{ id: "account", title: "Account", startPath: "/account", steps: [{ type: "expectText", target: { role: "main" }, text: DEMO_USER.email }] }];
  const engine = new Engine({ projectDir: await tempProject({ target: targetFor(baseUrl), auth: authConfig, journeys, budgets: { maxCases: 1 }, policy }) });
  try {
    await engine.login();
    // Restart the app: its in-memory sessions are gone, but the saved session file is still young.
    await close(server);
    server = createDemoServer();
    await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve));
    assert.equal((server.address() as AddressInfo).port, port);
    const plan = await engine.plan();
    const run = await engine.run(plan.id);
    const journey = run.executions.find(item => item.testCaseId === "TS-JRNY-account")!;
    assert.equal(journey.outcome, "passed", journey.error);
  } finally { engine.close(); await close(server); delete process.env.TESTSWARM_REGRESSION_PASSWORD; }
});

test("model-assisted planning snapshots signed-in pages when login is configured", async () => {
  process.env.TESTSWARM_REGRESSION_PASSWORD = DEMO_USER.password;
  const server = createDemoServer();
  const baseUrl = await listen(server);
  const seen: PageSnapshot[] = [];
  const proposer: JourneyProposer = { name: "capture", async propose(snapshots) { seen.push(...snapshots); return { journeys: [] }; } };
  const engine = new Engine({ projectDir: await tempProject({ target: targetFor(baseUrl, { routes: ["/account"] }), auth: authConfig, llm: { enabled: true }, policy }), journeyProposer: proposer });
  try {
    await engine.planWithAi();
    const account = seen.find(item => item.path === "/account");
    assert.ok(account, `snapshotted: ${seen.map(item => item.path).join(", ")}`);
    assert.match(account!.snapshot, /Signed in as demo@example\.com/);
  } finally { engine.close(); await close(server); delete process.env.TESTSWARM_REGRESSION_PASSWORD; }
});

test("an unreachable login page fails with a login error that says what to check", async () => {
  process.env.TESTSWARM_REGRESSION_PASSWORD = "x";
  const engine = new Engine({ projectDir: await tempProject({ target: targetFor(await unusedPort()), auth: authConfig, policy }) });
  try { await assert.rejects(() => engine.login(), (error: Error) => error.name === "LoginError" && /Could not open the login page .*Is the application running\?/.test(error.message) && !/Call log/.test(error.message)); }
  finally { engine.close(); delete process.env.TESTSWARM_REGRESSION_PASSWORD; }
});

test("Ctrl-C during a CLI run cancels it instead of leaving it marked running", { skip: process.platform === "win32" }, async () => {
  const server = createDemoServer();
  const baseUrl = await listen(server);
  const dir = await tempProject({ target: targetFor(baseUrl, { viewportProfiles: [{ name: "a", width: 800, height: 600 }, { name: "b", width: 400, height: 800 }] }), budgets: { maxConcurrency: 1 }, policy });
  const engine = new Engine({ projectDir: dir });
  try {
    const plan = await engine.planFromDiscovery();
    const child = spawn(process.execPath, [cli, "-p", dir, "run", plan.id], { stdio: ["ignore", "ignore", "pipe"] });
    let runId: string | undefined;
    for (let attempt = 0; attempt < 200 && !runId; attempt++) {
      const [latest] = await engine.runs(1);
      if (latest && latest.summary.total > 0) runId = latest.id; else await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(runId, "run started");
    child.kill("SIGINT");
    const code = await new Promise<number | null>(resolve => child.on("exit", resolve));
    assert.equal(code, 130);
    const progress = await engine.progress(runId!);
    assert.equal(progress.status, "cancelled");
    assert.ok(progress.nextSteps.some(step => /resume/.test(step)));
  } finally { engine.close(); await close(server); }
});
