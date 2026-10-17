import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Server } from "node:http";
import { Engine } from "../../src/core/engine.js";
import { JsonStore } from "../../src/core/store.js";
import type { JourneyProposer, PageSnapshot, RawJourney } from "../../src/llm/provider.js";
import { close, listen, targetFor, tempProject } from "../helpers.js";

const { createDemoServer, DEMO_USER } = await import(new URL("../../../fixtures/demo-app/app.mjs", import.meta.url).href) as { createDemoServer(options?: { seeded?: boolean }): Server; DEMO_USER: { email: string; password: string } };
const policy = { trace: "retain-on-failure" };
const budgets = { maxConcurrency: 2, maxRetries: 0 };

let server: Server, baseUrl = "";
test.before(async () => { server = createDemoServer(); baseUrl = await listen(server); });
test.after(() => close(server));

const journeys = [
  { id: "search", title: "Search finds mugs", startPath: "/search", steps: [
    { type: "fill", target: { label: "Search products" }, value: "mug" },
    { type: "click", target: { role: "button", name: "Search" } },
    { type: "expectUrl", path: "q=mug" },
    { type: "expectText", target: { role: "heading", name: "Results for mug" }, text: "mug" }
  ] },
  { id: "cart", title: "Add to cart updates the count", startPath: "/products", steps: [
    { type: "click", target: { role: "button", name: "Add to cart" } },
    { type: "click", target: { role: "button", name: "Add to cart" } },
    { type: "expectText", target: { testId: "cart-count" }, text: "2" }
  ] },
  { id: "wrong", title: "A journey that fails on step 2", startPath: "/products", steps: [
    { type: "click", target: { role: "button", name: "Add to cart" } },
    { type: "expectText", target: { testId: "cart-count" }, text: "5" }
  ] },
  { id: "secret", title: "Uses an unset secret", startPath: "/login", steps: [
    { type: "fill", target: { label: "Password" }, valueFromEnv: "TESTSWARM_UNSET_SECRET" },
    { type: "expectTitle", text: "Sign in" }
  ] }
].map(journey => ({ ...journey, steps: journey.steps.map(step => JSON.parse(JSON.stringify(step))) }));

test("configured journeys run as cases: pass, fail at the right step, and block on missing secrets", async () => {
  const engine = new Engine({ projectDir: await tempProject({ target: { ...targetFor(baseUrl), actionTimeoutMs: 2000 }, budgets, policy, journeys }) });
  try {
    const plan = await engine.plan();
    assert.deepEqual(plan.cases.slice(0, 4).map(item => item.id), ["TS-JRNY-search", "TS-JRNY-cart", "TS-JRNY-wrong", "TS-JRNY-secret"]);
    const run = await engine.run(plan.id);
    const outcome = (id: string) => run.executions.find(item => item.testCaseId === id)!;
    assert.equal(outcome("TS-JRNY-search").outcome, "passed", outcome("TS-JRNY-search").error);
    assert.equal(outcome("TS-JRNY-cart").outcome, "passed", outcome("TS-JRNY-cart").error);
    assert.equal(outcome("TS-JRNY-wrong").outcome, "failed");
    assert.match(outcome("TS-JRNY-wrong").error!, /Step 2 \(expect test id "cart-count" to contain "5"\) failed: text was "1"/);
    assert.ok(outcome("TS-JRNY-wrong").evidence.some(item => item.kind === "trace"), "failed journeys keep a trace");
    assert.equal(outcome("TS-JRNY-secret").outcome, "blocked");
    assert.match(outcome("TS-JRNY-secret").error!, /TESTSWARM_UNSET_SECRET is not set/);
    const exported = await readFile((await engine.exportPlan(plan.id)).file, "utf8");
    assert.match(exported, /await page\.getByLabel\("Search products"\)\.fill\("mug"\);/);
    assert.match(exported, /process\.env\.TESTSWARM_UNSET_SECRET/);
  } finally { engine.close(); }
});

test("scripted login saves a session that authenticated journeys reuse, without tracing the password", async () => {
  process.env.TESTSWARM_DEMO_PASSWORD = DEMO_USER.password;
  const auth = { loginPath: "/login", successPath: "/account", steps: [
    { type: "fill", target: { label: "Email" }, value: DEMO_USER.email },
    { type: "fill", target: { label: "Password" }, valueFromEnv: "TESTSWARM_DEMO_PASSWORD" },
    { type: "click", target: { role: "button", name: "Sign in" } }
  ] };
  const account = [{ id: "account", title: "Signed-in users see their account", startPath: "/account", steps: [{ type: "expectText", target: { role: "main" }, text: DEMO_USER.email }] }];
  const dir = await tempProject({ target: { ...targetFor(baseUrl), actionTimeoutMs: 2000 }, budgets, policy: { trace: "on" }, auth, journeys: account });
  const engine = new Engine({ projectDir: dir });
  try {
    const login = await engine.login();
    const saved = JSON.parse(await readFile(login.storageStatePath!, "utf8"));
    assert.ok(saved.cookies.some((cookie: { name: string }) => cookie.name === "session"));
    if (process.platform !== "win32") assert.equal((await stat(login.storageStatePath!)).mode & 0o077, 0, "session file is owner-only");
    const plan = await engine.plan();
    const run = await engine.run(plan.id);
    const journey = run.executions.find(item => item.testCaseId === "TS-JRNY-account")!;
    assert.equal(journey.outcome, "passed", journey.error);
    // A wrong password fails the run up front with a clear error instead of running every case logged out.
    process.env.TESTSWARM_DEMO_PASSWORD = "wrong";
    const failed = await (new Engine({ projectDir: dir })).login().then(() => "logged in", (error: Error) => error.message);
    assert.match(failed, /Login failed: Step 1 \(expect URL to contain \/account\)/);
  } finally { engine.close(); delete process.env.TESTSWARM_DEMO_PASSWORD; }
});

test("model-assisted planning validates proposals, records them for review, and blocks state-changing ones", async () => {
  const seen: PageSnapshot[][] = [];
  const proposer: JourneyProposer = {
    name: "fake",
    async propose(snapshots) {
      seen.push(snapshots);
      const journeys: RawJourney[] = [
        { id: "browse", title: "Open products from home", startPath: "/", priority: "high", rationale: "navigation", steps: [
          { type: "click", locatorKind: "role", locatorValue: "link", roleName: "Products", value: null, path: null, key: null },
          { type: "expectUrl", locatorKind: null, locatorValue: null, roleName: null, value: null, path: "/products", key: null }] },
        { id: "search", title: "Search for a teapot", startPath: "/search", priority: "medium", rationale: "search", steps: [
          { type: "fill", locatorKind: "label", locatorValue: "Search products", roleName: null, value: "teapot", path: null, key: null },
          { type: "press", locatorKind: "label", locatorValue: "Search products", roleName: null, value: null, path: null, key: "Enter" },
          { type: "expectText", locatorKind: "role", locatorValue: "list", roleName: null, value: "Red teapot", path: null, key: null }] },
        { id: "invented", title: "Uses a page that was not shown", startPath: "/admin", priority: "low", rationale: "x", steps: [] }
      ];
      return { journeys, usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, model: "fake" } };
    }
  };
  const dir = await tempProject({ target: targetFor(baseUrl), budgets, policy, llm: { enabled: true, maxRoutes: 4 } });
  const engine = new Engine({ projectDir: dir, journeyProposer: proposer });
  try {
    const result = await engine.planWithAi();
    assert.ok(seen[0].some(item => item.path === "/search" && item.snapshot.includes("Search products")), "snapshots carry the accessibility tree");
    assert.equal(result.proposedJourneys, 2);
    assert.deepEqual(result.blockedUntilReviewed, ["ai-search"]);
    assert.deepEqual(result.rejected.map(item => item.id), ["invented"]);
    const review = JSON.parse(await readFile(result.file, "utf8"));
    assert.equal(review.journeys.length, 2);
    const run = await engine.run(result.plan.id);
    const byId = (id: string) => run.executions.find(item => item.testCaseId === id)!;
    assert.equal(byId("TS-JRNY-ai-browse").outcome, "passed", byId("TS-JRNY-ai-browse").error);
    assert.equal(byId("TS-JRNY-ai-search").outcome, "blocked");
    assert.equal(result.plan.cases.find(item => item.id === "TS-JRNY-ai-browse")?.origin, "generated");
  } finally { engine.close(); }
});

test("model-assisted planning is refused unless explicitly enabled", async () => {
  const engine = new Engine({ projectDir: await tempProject({ target: targetFor(baseUrl) }) });
  try { await assert.rejects(() => engine.planWithAi(), /Model-assisted planning is off/); } finally { engine.close(); }
});

test("a running run whose process stopped heartbeating is reported stale and resumes without --force", async () => {
  const dir = await tempProject({ target: targetFor(baseUrl), budgets, policy: { trace: "off" } });
  const file = join(dir, "store.json");
  const engine = new Engine({ projectDir: dir, store: new JsonStore(file) });
  try {
    const plan = await engine.plan();
    const state = JSON.parse(await readFile(file, "utf8"));
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    state.runs.orphan = { id: "orphan", projectName: "p", planId: plan.id, status: "running", startedAt: old, executions: [], activityAt: old };
    state.runs.fresh = { id: "fresh", projectName: "p", planId: plan.id, status: "running", startedAt: old, executions: [], activityAt: new Date().toISOString() };
    await writeFile(file, JSON.stringify(state));
    assert.equal((await engine.progress("orphan")).stale, true);
    assert.equal((await engine.progress("fresh")).stale, false);
    await assert.rejects(() => engine.resume("fresh"), /still running/);
    const resumed = await engine.resume("orphan");
    assert.ok(["completed", "failed"].includes(resumed.status));
    assert.ok(resumed.executions.length > 0);
  } finally { engine.close(); }
});
