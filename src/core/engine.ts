import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ConfigError, loadConfig, locateProject, starterConfig } from "./config.js";
import { ProjectConfiguration, SeededDefect, TestCase, TestExecution, TestPlan, TestRun } from "./contracts.js";
import { Store, SqliteStore } from "./store.js";
import { HttpTestDataProvider } from "./http-test-data.js";
import { runDoctor } from "./doctor.js";
import { createPlanForRoutes, createPlanFromDiscovery, journeysToCases } from "../planner/planner.js";
import { BrowserPool, baselineFile, executeCaseWithRetry, navigationPath } from "../browser-runtime/runner.js";
import { discoverApplication } from "../discovery/discover.js";
import { buildReport, summarize, writeReport } from "../reporting/report.js";
import { classifyFailures } from "../verification/verifier.js";
import { measureRun, writeBenchmark } from "../benchmarks/benchmark.js";
import { compareRuns } from "../benchmarks/compare.js";
import { runSpecialists } from "../agents/orchestrator.js";
import { ensureAuthenticated } from "../browser-runtime/auth.js";
import { describeAction } from "../browser-runtime/actions.js";
import { AnthropicJourneyProposer } from "../llm/anthropic.js";
import { JourneyProposer, validateProposals } from "../llm/provider.js";
import { snapshotRoutes } from "../llm/snapshot.js";
import type { Action, Locator } from "./contracts.js";

export interface EngineOptions {
  /** Project directory; defaults to TESTSWARM_PROJECT_DIR or the working directory. */
  projectDir?: string;
  /** Config path relative to the project directory; defaults to TESTSWARM_CONFIG or testswarm.config.json. */
  configPath?: string;
  /** Injected store (tests). By default a SQLite store under the configured artifacts directory is opened lazily. */
  store?: Store;
  /** Injected model-backed journey proposer (tests). By default built from the llm config. */
  journeyProposer?: JourneyProposer;
  /** Injected LangChain chat model for the deep-agent explorer (tests). By default Claude via @langchain/anthropic. */
  agentModel?: unknown;
}

/** A run marked running whose process has not written for this long is treated as abandoned. */
const STALE_AFTER_MS = 2 * 60_000;
const HEARTBEAT_MS = 15_000;

interface WorkItem { testCase: TestCase; profile: { name: string; width: number; height: number } }
const TERMINAL = new Set(["completed", "failed", "blocked", "cancelled"]);

/** Final status from the latest execution of each case: failures win, then cases waiting on a person. */
export function outcomeStatus(executions: TestExecution[]): TestRun["status"] {
  if (executions.every(isGreen)) return "completed";
  return executions.some(item => item.outcome === "failed" || item.outcome === "infrastructure_failure") ? "failed" : "blocked";
}

/** Plain-language next steps for a finished run, so people and agents know what to do with it. */
export function nextSteps(run: TestRun): string[] {
  const latest = latestExecutions(run), steps: string[] = [];
  const count = (outcome: TestExecution["outcome"]) => latest.filter(item => item.outcome === outcome).length;
  const missingBaselines = latest.filter(item => item.outcome === "blocked" && /Missing visual baseline/.test(item.error ?? "")).length;
  if (run.status === "running") return [`Still running: poll status for ${run.id}.`];
  if (run.status === "cancelled") steps.push(`The run was cancelled after ${run.executions.length}${run.expectedExecutions ? ` of ${run.expectedExecutions}` : ""} execution(s); continue it with resume ${run.id}.`);
  if (run.error) steps.push(`The run stopped early: ${run.error}`);
  if (count("infrastructure_failure")) steps.push(`${count("infrastructure_failure")} execution(s) could not run because of the environment (browser or target). Run doctor.`);
  if (count("failed")) steps.push(`${count("failed")} execution(s) failed: review them with verify ${run.id} and the screenshots, fix, then retest ${run.id}.`);
  if (missingBaselines) steps.push(`${missingBaselines} visual check(s) have no approved baseline yet. Look at the screenshots; if they are correct, approve them with baseline ${run.id}, then run the plan again.`);
  const otherBlocked = count("blocked") - missingBaselines;
  if (otherBlocked) steps.push(`${otherBlocked} case(s) were blocked by policy or a missing secret; see each case's error.`);
  if (count("flaky")) steps.push(`${count("flaky")} case(s) passed only after a retry (flaky).`);
  if (!steps.length && run.status === "completed") steps.push("Everything passed.");
  return steps;
}
const executionKey = (item: { testCaseId: string; viewportProfile?: string }) => `${item.testCaseId}@${item.viewportProfile ?? "default"}`;
const isGreen = (execution: TestExecution) => execution.outcome === "passed" || execution.outcome === "flaky";

/** The most recent execution for each case and viewport profile (a resumed run may hold several attempts). */
export function latestExecutions(run: TestRun) {
  const latest = new Map<string, TestExecution>();
  for (const execution of run.executions) latest.set(executionKey(execution), execution);
  return [...latest.values()];
}

export class Engine {
  private storeInstance?: Store;
  private readonly active = new Map<string, Promise<TestRun>>();
  readonly location: ReturnType<typeof locateProject>;

  constructor(private readonly options: EngineOptions = {}) {
    this.location = locateProject(options);
    this.storeInstance = options.store;
  }

  async config(): Promise<ProjectConfiguration> { return loadConfig(this.location.configPath, this.location.root); }

  private async store(): Promise<Store> {
    if (!this.storeInstance) this.storeInstance = new SqliteStore(join((await this.config()).artifactsDir, "testswarm.db"));
    return this.storeInstance;
  }

  close() { this.storeInstance?.close(); this.storeInstance = undefined; }

  /** Cancels runs executing in this process, waits up to `timeoutMs` for them to stop, then closes the store. */
  async shutdown(timeoutMs = 15_000) {
    if (this.active.size) {
      const store = await this.store();
      for (const id of this.active.keys()) await store.requestCancel(id);
      await Promise.race([Promise.allSettled([...this.active.values()]), new Promise(resolve => setTimeout(resolve, timeoutMs).unref())]);
    }
    this.close();
  }

  /** Writes a starter configuration if none exists. */
  async init(baseUrl?: string) {
    try { await access(this.location.configPath); return { created: false, path: this.location.configPath }; } catch { /* create below */ }
    await mkdir(dirname(this.location.configPath), { recursive: true });
    await writeFile(this.location.configPath, JSON.stringify(starterConfig(baseUrl), null, 2) + "\n");
    return { created: true, path: this.location.configPath };
  }

  /** Applies scripted login (when configured) so the target uses a fresh saved session. */
  private async authenticate(config: ProjectConfiguration, force = false) {
    if (config.auth) config.target.storageStatePath = await ensureAuthenticated(config, { force });
    return config;
  }

  /** Runs the configured login now and saves the session, replacing any saved one. */
  async login() {
    const config = await this.config();
    if (!config.auth) throw new UsageError('No "auth" section in the configuration');
    await this.authenticate(config, true);
    return { storageStatePath: config.target.storageStatePath, maxAgeMinutes: config.auth.maxAgeMinutes };
  }

  async inspect() { return this.config(); }
  async doctor() { return runDoctor(this.location); }

  async discover() {
    const config = await this.authenticate(await this.config());
    const result = await discoverApplication(config.target, config.budgets.maxRoutes);
    const directory = join(config.artifactsDir, "discovery");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "latest.json"), JSON.stringify(result, null, 2));
    return result;
  }

  /** An empty crawl almost always means the target is down or misconfigured; never turn it into an empty, "passing" plan. */
  private requireRoutes(discovery: Awaited<ReturnType<Engine["discover"]>>, config: ProjectConfiguration) {
    if (discovery.routes.length) return discovery;
    const reasons = discovery.warnings.slice(0, 3).map(item => item.split("\n")[0]).join("; ");
    throw new UsageError(`Discovery found no pages at ${config.target.baseUrl}${config.target.startPath}${reasons ? ` (${reasons})` : ""}. Is the application running? Check target.baseUrl, or run "testswarm doctor".`);
  }

  /** Plan from the configured start path and target.routes, without crawling. */
  async plan() {
    const config = await this.config();
    const paths = [...new Set([config.target.startPath, ...config.target.routes])];
    const plan = createPlanForRoutes(paths.map(path => ({ path, feature: path })), { maxCases: config.budgets.maxCases, journeys: journeysToCases(config.journeys) });
    await (await this.store()).putPlan(plan);
    return plan;
  }

  async planFromDiscovery() {
    const config = await this.config();
    const plan = createPlanFromDiscovery(this.requireRoutes(await this.discover(), config), { maxCases: config.budgets.maxCases, journeys: journeysToCases(config.journeys) });
    await (await this.store()).putPlan(plan);
    return plan;
  }

  /**
   * Crawls the target, sends redacted accessibility snapshots of up to llm.maxRoutes routes to the configured model,
   * and builds a plan of route checks + configured journeys + validated model-proposed journeys. Proposals are also
   * written to a file for review; any proposal that types, selects, or clicks non-links is marked "reversible" and
   * stays blocked until policy.allowDestructiveActions is set.
   */
  async planWithAi() {
    const config = await this.config();
    if (!config.llm?.enabled) throw new UsageError('Model-assisted planning is off. Add "llm": { "enabled": true } to the configuration; page snapshots will be sent to the model provider.');
    const proposer = this.options.journeyProposer ?? new AnthropicJourneyProposer(config.llm);
    const discovery = this.requireRoutes(await this.discover(), config);
    // Snapshots must see the same signed-in pages the run will test.
    await this.authenticate(config);
    const paths = discovery.routes.map(route => route.path).slice(0, config.llm.maxRoutes);
    const { snapshots, warnings } = await snapshotRoutes(config.target, paths, config.llm.maxSnapshotChars);
    const { journeys: raw, usage } = await proposer.propose(snapshots, { maxJourneysPerRoute: config.llm.maxJourneysPerRoute });
    const { journeys, rejected } = validateProposals(raw, new Set(snapshots.map(item => item.path)));
    const plan = createPlanFromDiscovery(discovery, { maxCases: config.budgets.maxCases, journeys: [...journeysToCases(config.journeys), ...journeysToCases(journeys, "generated")] });
    await (await this.store()).putPlan(plan);
    const directory = join(config.artifactsDir, "ai");
    await mkdir(directory, { recursive: true });
    const file = join(directory, `proposed-journeys-${plan.id}.json`);
    await writeFile(file, JSON.stringify({ planId: plan.id, provider: proposer.name, usage, journeys, rejected, warnings }, null, 2));
    return { plan, proposedJourneys: journeys.length, blockedUntilReviewed: journeys.filter(item => item.destructive !== "none").map(item => item.id), rejected, warnings, usage, file };
  }

  /**
   * Deep-agent exploratory planning: a LangGraph Deep Agent explores each route with a subagent, runs candidate
   * journeys in the browser, fixes failures, and submits them. Only journeys that passed join the plan; the rest,
   * plus candidate defects, go to a review file. See docs/architecture/deep-agent.md.
   */
  async planWithAgent() {
    const config = await this.config();
    if (!config.llm?.enabled) throw new UsageError('Agent planning is off. Add "llm": { "enabled": true } to the configuration; page snapshots will be sent to the model provider.');
    let explorer: typeof import("../agents/deep/explorer.js");
    try { explorer = await import("../agents/deep/explorer.js"); }
    catch (error) { throw new UsageError(`Agent planning needs the optional LangChain packages: npm install deepagents @langchain/anthropic @langchain/core @langchain/langgraph (${(error as Error).message.split("\n")[0]})`); }
    const discovery = this.requireRoutes(await this.discover(), config);
    // The agent must explore the same signed-in pages the run will test.
    await this.authenticate(config);
    const routes = discovery.routes.slice(0, config.llm.maxRoutes);
    const model = (this.options.agentModel ?? await explorer.createAnthropicChatModel({ model: config.llm.model, effort: config.llm.effort })) as Parameters<typeof explorer.runExplorer>[0]["model"];
    const result = await explorer.runExplorer({
      model, target: config.target, policy: config.policy, routes,
      limits: { ...config.llm.agent, maxJourneysPerRoute: config.llm.maxJourneysPerRoute, maxSnapshotChars: config.llm.maxSnapshotChars }
    });
    const verified = result.submissions.filter(item => item.verified).map(item => item.journey);
    const plan = createPlanFromDiscovery(discovery, { maxCases: config.budgets.maxCases, journeys: [...journeysToCases(config.journeys), ...journeysToCases(verified, "generated")] });
    await (await this.store()).putPlan(plan);
    const directory = join(config.artifactsDir, "ai");
    await mkdir(directory, { recursive: true });
    const file = join(directory, `agent-exploration-${plan.id}.json`);
    await writeFile(file, JSON.stringify({ planId: plan.id, model: config.llm.model, ...result }, null, 2));
    return {
      plan, file,
      verifiedJourneys: verified.length,
      forReview: result.submissions.filter(item => !item.verified).map(item => ({ id: item.journey.id, executed: item.executed, destructive: item.journey.destructive })),
      findings: result.findings.length,
      trials: result.trials, usage: result.usage, stoppedEarly: result.stoppedEarly
    };
  }

  async getPlan(planId: string) {
    const plan = await (await this.store()).getPlan(planId);
    if (!plan) throw new NotFoundError(`Plan not found: ${planId}`);
    return plan;
  }

  /** Starts a run in the background and returns it immediately with status "running". */
  async start(planId: string, options: { only?: Set<string>; retestOf?: string } = {}) {
    const config = await this.config(), plan = await this.getPlan(planId), store = await this.store();
    const items = this.workItems(config, plan).filter(item => !options.only || options.only.has(executionKey({ testCaseId: item.testCase.id, viewportProfile: item.profile.name })));
    if (!items.length) throw new UsageError(`Plan ${planId} has no cases to run, so a run could not show anything. Create a plan from a reachable target first.`);
    const run: TestRun = { id: randomUUID(), projectName: config.name, planId, status: "running", startedAt: new Date().toISOString(), expectedExecutions: items.length, ...(options.retestOf ? { retestOf: options.retestOf } : {}), executions: [] };
    await store.putRun(run);
    const done = this.execute(run, items, config).finally(() => this.active.delete(run.id));
    this.active.set(run.id, done);
    return { run, done };
  }

  /** Runs a plan to completion. */
  async run(planId: string) { return (await this.start(planId)).done; }

  /** Waits for a run started by this process; returns the stored run if it is not active here. */
  async wait(runId: string) { return this.active.get(runId) ?? this.status(runId); }

  private workItems(config: ProjectConfiguration, plan: TestPlan): WorkItem[] {
    const profiles = config.target.viewportProfiles.length ? config.target.viewportProfiles : [{ name: "default", ...config.target.viewport }];
    return plan.cases.flatMap(testCase => profiles.map(profile => ({ testCase, profile })));
  }

  private async execute(run: TestRun, items: WorkItem[], config: ProjectConfiguration): Promise<TestRun> {
    const store = await this.store();
    const provider = config.testData ? new HttpTestDataProvider(config.testData.setupUrl, config.testData.cleanupUrl, config.testData.fixturePath, config.testData.timeoutMs) : undefined;
    let fixture;
    // Lets other processes tell a live run from one whose process died (see progress().stale).
    const heartbeat = setInterval(() => { store.heartbeat(run.id).catch(() => undefined); }, HEARTBEAT_MS);
    heartbeat.unref();
    try {
      try { await this.authenticate(config); }
      catch (error) { return await this.finalize(run.id, "failed", error instanceof Error ? error.message : String(error)); }
      if (provider) {
        try { fixture = await provider.setup(); }
        catch (error) { return await this.finalize(run.id, "failed", `Test-data setup failed: ${error instanceof Error ? error.message : String(error)}`); }
      }
      const queue = [...items];
      const workers = Math.max(1, Math.min(config.budgets.maxConcurrency, queue.length));
      await Promise.all(Array.from({ length: workers }, async () => {
        const pool = new BrowserPool(config.target);
        try {
          for (let item = queue.shift(); item; item = queue.shift()) {
            if (await store.isCancelRequested(run.id)) { queue.length = 0; break; }
            const target = { ...config.target, viewport: { width: item.profile.width, height: item.profile.height }, viewportProfileName: item.profile.name };
            let browser;
            try { browser = await pool.acquire(); }
            catch (error) { await store.addExecution(run.id, this.infrastructureFailure(item, error)); continue; }
            const execution = await executeCaseWithRetry(target, item.testCase, join(config.artifactsDir, "runs", run.id, item.profile.name, item.testCase.id), config.budgets.maxRetries, { browser, policy: config.policy });
            await store.addExecution(run.id, execution);
          }
        } finally { await pool.close(); }
      }));
      if (await store.isCancelRequested(run.id)) return await this.finalize(run.id, "cancelled");
      const current = (await store.getRun(run.id))!;
      return await this.finalize(run.id, outcomeStatus(latestExecutions(current)));
    } catch (error) {
      return await this.finalize(run.id, "failed", error instanceof Error ? error.message : String(error));
    } finally {
      clearInterval(heartbeat);
      if (fixture && provider) await provider.cleanup(fixture).catch(() => undefined);
    }
  }

  private infrastructureFailure(item: WorkItem, error: unknown): TestExecution {
    const now = new Date().toISOString();
    return { id: randomUUID(), testCaseId: item.testCase.id, viewportProfile: item.profile.name, outcome: "infrastructure_failure", startedAt: now, finishedAt: now, error: `Browser launch failed: ${error instanceof Error ? error.message : String(error)}`, evidence: [] };
  }

  private async finalize(runId: string, status: TestRun["status"], error?: string) {
    const store = await this.store(), run = (await store.getRun(runId))!;
    run.status = status;
    run.finishedAt = new Date().toISOString();
    if (error) run.error = error;
    await store.putRun(run);
    return run;
  }

  async status(id: string) {
    const run = await (await this.store()).getRun(id);
    if (!run) throw new NotFoundError(`Run not found: ${id}`);
    return run;
  }

  /** Progress summary suitable for polling. */
  async progress(id: string) {
    const run = await this.status(id);
    const stale = await this.isStale(run);
    return { runId: run.id, planId: run.planId, status: run.status, completedExecutions: run.executions.length, expectedExecutions: run.expectedExecutions, summary: summarize(latestExecutions(run)), nextSteps: nextSteps(run), startedAt: run.startedAt, finishedAt: run.finishedAt, error: run.error, activeInThisProcess: this.active.has(id), stale, ...(stale ? { hint: `No activity for over ${STALE_AFTER_MS / 60_000} minutes; its process probably exited. Resume it with "testswarm resume ${run.id}".` } : {}) };
  }

  /** True when a run is marked running but no process has written to it recently. */
  private async isStale(run: TestRun, now = Date.now()) {
    if (run.status !== "running" || this.active.has(run.id)) return false;
    const last = await (await this.store()).lastActivity(run.id);
    return last !== undefined && now - Date.parse(last) > STALE_AFTER_MS;
  }

  /** Requests cancellation. Any process executing the run stops before its next case. */
  async cancel(id: string) {
    const store = await this.store(), run = await this.status(id);
    if (TERMINAL.has(run.status)) return run;
    await store.requestCancel(id);
    if (this.active.has(id)) return this.active.get(id)!;
    run.status = "cancelled";
    run.finishedAt = new Date().toISOString();
    await store.putRun(run);
    return run;
  }

  async runs(limit = 20) { return (await (await this.store()).listRuns(limit)).map(run => ({ id: run.id, planId: run.planId, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt, summary: summarize(latestExecutions(run)) })); }

  async report(runId: string) {
    const config = await this.config(), run = await this.status(runId), plan = await this.getPlan(run.planId);
    const effective = { ...run, executions: latestExecutions(run) };
    const report = buildReport(effective, plan);
    return { report, files: await writeReport(report, join(config.artifactsDir, "reports"), plan) };
  }

  async results(runId: string) { return this.status(runId); }

  async evidence(runId: string) {
    const run = await this.status(runId);
    return run.executions.flatMap(execution => execution.evidence.map(item => ({ ...item, executionId: execution.id, testCaseId: execution.testCaseId, viewportProfile: execution.viewportProfile })));
  }

  async verify(runId: string) {
    const run = await this.status(runId), plan = await this.getPlan(run.planId);
    return classifyFailures({ ...run, executions: latestExecutions(run) }, plan);
  }

  /** Re-runs only the case/profile pairs that did not pass in the given run, as a new run. */
  async startRetest(runId: string) {
    const run = await this.status(runId);
    const only = new Set(latestExecutions(run).filter(item => !isGreen(item)).map(executionKey));
    if (!only.size) throw new UsageError(`Run ${runId} has no failing executions to retest`);
    return this.start(run.planId, { only, retestOf: runId });
  }

  async retest(runId: string) { return (await this.startRetest(runId)).done; }

  /** Continues a run in place, executing only pairs without a passing result. */
  async resume(runId: string, options: { force?: boolean } = {}) { return (await this.startResume(runId, options)).done; }

  async startResume(runId: string, options: { force?: boolean } = {}) {
    const config = await this.config(), store = await this.store(), run = await this.status(runId), plan = await this.getPlan(run.planId);
    if (run.status === "completed") throw new UsageError(`Run ${runId} already completed`);
    if (run.status === "running" && (this.active.has(runId) || !(options.force || await this.isStale(run)))) throw new UsageError(`Run ${runId} is still running (last activity under ${STALE_AFTER_MS / 60_000} minutes ago). If its process is gone, resume with --force.`);
    const passed = new Set(run.executions.filter(isGreen).map(executionKey));
    const items = this.workItems(config, plan).filter(item => !passed.has(executionKey({ testCaseId: item.testCase.id, viewportProfile: item.profile.name })));
    await store.requestCancel(runId, false);
    run.status = "running"; run.finishedAt = undefined; run.error = undefined;
    run.expectedExecutions = items.length + passed.size;
    await store.putRun(run);
    const done = this.execute(run, items, config).finally(() => this.active.delete(runId));
    this.active.set(runId, done);
    return { run, done };
  }

  async repeat(planId: string, count = 2) {
    if (!Number.isInteger(count) || count < 2 || count > 10) throw new UsageError("Repeat count must be an integer from 2 to 10");
    const runs: TestRun[] = [];
    for (let index = 0; index < count; index++) runs.push(await this.run(planId));
    const outcomesByKey = new Map<string, Set<string>>();
    for (const run of runs) for (const execution of latestExecutions(run)) outcomesByKey.set(executionKey(execution), (outcomesByKey.get(executionKey(execution)) ?? new Set()).add(isGreen(execution) ? "green" : execution.outcome));
    const unstable = [...outcomesByKey].filter(([, outcomes]) => outcomes.size > 1).map(([key]) => key);
    return { planId, requestedRuns: count, runIds: runs.map(run => run.id), summaries: runs.map(run => summarize(latestExecutions(run))), unstable, stable: unstable.length === 0 };
  }

  /** Exports a plan as a standalone @playwright/test spec that performs the same checks as the runner. */
  async exportPlan(planId: string) {
    const plan = await this.getPlan(planId), config = await this.config();
    const directory = join(config.artifactsDir, "exports");
    await mkdir(directory, { recursive: true });
    const file = join(directory, `${plan.id}.spec.ts`);
    const impact = ["minor", "moderate", "serious", "critical"];
    const blocking = JSON.stringify(impact.slice(impact.indexOf(config.policy.accessibilityFailOn)));
    const body = (testCase: TestCase) => {
      const path = JSON.stringify(navigationPath(testCase, config.target.startPath));
      const lines = [`  const response = await page.goto(${path});`, `  expect(response?.status() ?? 200).toBeLessThan(400);`];
      if (testCase.category === "functional") lines.push(`  await expect(page.getByRole("heading").first()).toBeVisible();`);
      if (testCase.category === "accessibility") lines.push(`  const { violations } = await new AxeBuilder({ page }).analyze();`, `  expect(violations.filter(v => ${blocking}.includes(v.impact ?? "")).map(v => v.id)).toEqual([]);`);
      if (testCase.category === "responsive") lines.push(`  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);`, `  expect(overflow).toBe(false);`);
      if (testCase.category === "ui") lines.push(`  await expect(page).toHaveScreenshot(${JSON.stringify(`${testCase.id}.png`)}, { fullPage: true, maxDiffPixelRatio: ${config.policy.visualMaxDiffRatio} });`);
      if (testCase.category === "journey") for (const step of testCase.actions ?? []) lines.push(`  // ${describeAction(step).replace(/\n/g, " ")}`, `  ${exportAction(step)}`);
      return lines.join("\n");
    };
    const source = [
      `// Generated by TestSwarm from plan ${plan.id}. Requires @playwright/test${plan.cases.some(item => item.category === "accessibility") ? " and @axe-core/playwright" : ""}.`,
      `import { test, expect } from "@playwright/test";`,
      ...(plan.cases.some(item => item.category === "accessibility") ? [`import AxeBuilder from "@axe-core/playwright";`] : []),
      ``,
      `test.use({ baseURL: ${JSON.stringify(config.target.baseUrl)} });`,
      ``,
      ...plan.cases.map(testCase => `test(${JSON.stringify(`${testCase.id}: ${testCase.title}`)}, async ({ page }) => {\n${body(testCase)}\n});\n`)
    ].join("\n");
    await writeFile(file, source);
    return { file, testCount: plan.cases.length };
  }

  async benchmark(runId: string) {
    const config = await this.config(), run = await this.status(runId), plan = await this.getPlan(run.planId);
    let oracle: SeededDefect[] = [];
    if (config.benchmarkOraclePath) oracle = (JSON.parse(await readFile(config.benchmarkOraclePath, "utf8")) as unknown[]).map(item => SeededDefect.parse(item));
    const result = measureRun({ ...run, executions: latestExecutions(run) }, plan, oracle);
    return { result, file: await writeBenchmark(result, join(config.artifactsDir, "benchmarks")) };
  }

  async compare(firstRunId: string, secondRunId: string) {
    const first = await this.status(firstRunId), second = await this.status(secondRunId);
    return compareRuns({ ...first, executions: latestExecutions(first) }, { ...second, executions: latestExecutions(second) });
  }

  /** Runs the specialist agents without persisting a run. */
  async agents(planId: string) {
    const config = await this.authenticate(await this.config()), plan = await this.getPlan(planId);
    return runSpecialists({ target: config.target, artifactsDir: join(config.artifactsDir, "agent-runs", plan.id), retryBudget: config.budgets.maxRetries, policy: config.policy }, plan.cases);
  }

  /** Runs the specialist agents and persists the result as a regular, comparable run. */
  async agentRun(planId: string) {
    const config = await this.authenticate(await this.config()), plan = await this.getPlan(planId), store = await this.store();
    const profiles = config.target.viewportProfiles.length || 1;
    const run: TestRun = { id: randomUUID(), projectName: `${config.name}:specialists`, planId, status: "running", startedAt: new Date().toISOString(), expectedExecutions: plan.cases.length * profiles, executions: [] };
    await store.putRun(run);
    try {
      const result = await runSpecialists({ target: config.target, artifactsDir: join(config.artifactsDir, "agent-runs", run.id), retryBudget: config.budgets.maxRetries, policy: config.policy, onExecution: execution => store.addExecution(run.id, execution), shouldCancel: () => store.isCancelRequested(run.id) }, plan.cases);
      const finished = (await store.getRun(run.id))!;
      const status = (await store.isCancelRequested(run.id)) ? "cancelled" : result.agents.every(agent => agent.status === "completed") ? outcomeStatus(latestExecutions(finished)) : "failed";
      return { run: await this.finalize(run.id, status), agents: result.agents };
    } catch (error) {
      return { run: await this.finalize(run.id, "failed", error instanceof Error ? error.message : String(error)), agents: [] };
    }
  }

  /**
   * Approves the screenshots of a run's UI cases as visual baselines. Pass caseIds to approve a subset.
   * This is a deliberate human decision: review the screenshots before approving.
   */
  async baseline(runId: string, caseIds?: string[]) {
    const config = await this.config(), run = await this.status(runId), plan = await this.getPlan(run.planId);
    const uiCases = new Map(plan.cases.filter(item => item.category === "ui" && (!caseIds?.length || caseIds.includes(item.id))).map(item => [item.id, item]));
    const files: string[] = [];
    for (const execution of latestExecutions(run)) {
      const testCase = uiCases.get(execution.testCaseId);
      const screenshot = execution.evidence.find(item => item.kind === "screenshot" && item.path.endsWith("page.png"));
      if (!testCase || !screenshot) continue;
      const file = baselineFile({ ...config.target, viewportProfileName: execution.viewportProfile }, testCase);
      await mkdir(dirname(file), { recursive: true });
      await copyFile(screenshot.path, file);
      files.push(file);
    }
    return { runId, files };
  }

  /** Deletes old finished runs and their artifacts, keeping the newest `keep` (default policy.retainRuns). */
  async prune(keep?: number) {
    const config = await this.config(), store = await this.store();
    const removed = await store.pruneRuns(keep ?? config.policy.retainRuns);
    for (const id of removed) await rm(join(config.artifactsDir, "runs", id), { recursive: true, force: true });
    return { removed };
  }
}

/** Playwright Test source for one journey step. Secrets stay in environment variables. */
function exportAction(step: Action): string {
  const q = JSON.stringify;
  const loc = (locator: Locator) =>
    "role" in locator ? `page.getByRole(${q(locator.role)}${locator.name ? `, { name: ${q(locator.name)}${locator.exact ? ", exact: true" : ""} }` : ""})`
    : "label" in locator ? `page.getByLabel(${q(locator.label)})`
    : "text" in locator ? `page.getByText(${q(locator.text)})`
    : "placeholder" in locator ? `page.getByPlaceholder(${q(locator.placeholder)})`
    : "testId" in locator ? `page.getByTestId(${q(locator.testId)})`
    : `page.locator(${q(locator.css)})`;
  switch (step.type) {
    case "goto": return `await page.goto(${q(step.path)});`;
    case "click": return `await ${loc(step.target)}.click();`;
    case "fill": return `await ${loc(step.target)}.fill(${step.valueFromEnv ? `process.env.${step.valueFromEnv} ?? ""` : q(step.value)});`;
    case "select": return `await ${loc(step.target)}.selectOption(${q(step.value)});`;
    case "check": return `await ${loc(step.target)}.setChecked(${step.checked ?? true});`;
    case "press": return step.target ? `await ${loc(step.target)}.press(${q(step.key)});` : `await page.keyboard.press(${q(step.key)});`;
    case "waitFor": return `await ${loc(step.target)}.waitFor({ state: ${q(step.state ?? "visible")} });`;
    case "expectVisible": return `await expect(${loc(step.target)}).toBeVisible();`;
    case "expectHidden": return `await expect(${loc(step.target)}).toBeHidden();`;
    case "expectText": return `await expect(${loc(step.target)}).toContainText(${q(step.text)});`;
    case "expectUrl": return `await expect(page).toHaveURL(url => (url.pathname + url.search + url.hash).includes(${q(step.path)}));`;
    case "expectTitle": return `await expect(page).toHaveTitle(new RegExp(${q(step.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))}));`;
  }
}

export class NotFoundError extends Error { override name = "NotFoundError"; }
export class UsageError extends Error { override name = "UsageError"; }
export { ConfigError };
