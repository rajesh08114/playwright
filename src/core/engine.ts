import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ConfigError, loadConfig, locateProject, starterConfig } from "./config.js";
import { ProjectConfiguration, SeededDefect, TestCase, TestExecution, TestPlan, TestRun } from "./contracts.js";
import { Store, SqliteStore } from "./store.js";
import { HttpTestDataProvider } from "./http-test-data.js";
import { runDoctor } from "./doctor.js";
import { createPlanForRoutes, createPlanFromDiscovery } from "../planner/planner.js";
import { BrowserPool, baselineFile, executeCaseWithRetry, navigationPath } from "../browser-runtime/runner.js";
import { discoverApplication } from "../discovery/discover.js";
import { buildReport, summarize, writeReport } from "../reporting/report.js";
import { classifyFailures } from "../verification/verifier.js";
import { measureRun, writeBenchmark } from "../benchmarks/benchmark.js";
import { compareRuns } from "../benchmarks/compare.js";
import { runSpecialists } from "../agents/orchestrator.js";

export interface EngineOptions {
  /** Project directory; defaults to TESTSWARM_PROJECT_DIR or the working directory. */
  projectDir?: string;
  /** Config path relative to the project directory; defaults to TESTSWARM_CONFIG or testswarm.config.json. */
  configPath?: string;
  /** Injected store (tests). By default a SQLite store under the configured artifacts directory is opened lazily. */
  store?: Store;
}

interface WorkItem { testCase: TestCase; profile: { name: string; width: number; height: number } }
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
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

  async inspect() { return this.config(); }
  async doctor() { return runDoctor(this.location); }

  async discover() {
    const config = await this.config();
    const result = await discoverApplication(config.target, config.budgets.maxRoutes);
    const directory = join(config.artifactsDir, "discovery");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "latest.json"), JSON.stringify(result, null, 2));
    return result;
  }

  /** Plan from the configured start path and target.routes, without crawling. */
  async plan() {
    const config = await this.config();
    const paths = [...new Set([config.target.startPath, ...config.target.routes])];
    const plan = createPlanForRoutes(paths.map(path => ({ path, feature: path })), { maxCases: config.budgets.maxCases });
    await (await this.store()).putPlan(plan);
    return plan;
  }

  async planFromDiscovery() {
    const config = await this.config();
    const plan = createPlanFromDiscovery(await this.discover(), { maxCases: config.budgets.maxCases });
    await (await this.store()).putPlan(plan);
    return plan;
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
    try {
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
      return await this.finalize(run.id, latestExecutions(current).every(isGreen) ? "completed" : "failed");
    } catch (error) {
      return await this.finalize(run.id, "failed", error instanceof Error ? error.message : String(error));
    } finally {
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
    return { runId: run.id, planId: run.planId, status: run.status, completedExecutions: run.executions.length, expectedExecutions: run.expectedExecutions, summary: summarize(latestExecutions(run)), startedAt: run.startedAt, finishedAt: run.finishedAt, error: run.error, activeInThisProcess: this.active.has(id) };
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
    if (run.status === "running" && (this.active.has(runId) || !options.force)) throw new UsageError(`Run ${runId} is marked running. If its process is gone, resume with --force.`);
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
    const config = await this.config(), plan = await this.getPlan(planId);
    return runSpecialists({ target: config.target, artifactsDir: join(config.artifactsDir, "agent-runs", plan.id), retryBudget: config.budgets.maxRetries, policy: config.policy }, plan.cases);
  }

  /** Runs the specialist agents and persists the result as a regular, comparable run. */
  async agentRun(planId: string) {
    const config = await this.config(), plan = await this.getPlan(planId), store = await this.store();
    const profiles = config.target.viewportProfiles.length || 1;
    const run: TestRun = { id: randomUUID(), projectName: `${config.name}:specialists`, planId, status: "running", startedAt: new Date().toISOString(), expectedExecutions: plan.cases.length * profiles, executions: [] };
    await store.putRun(run);
    try {
      const result = await runSpecialists({ target: config.target, artifactsDir: join(config.artifactsDir, "agent-runs", run.id), retryBudget: config.budgets.maxRetries, policy: config.policy, onExecution: execution => store.addExecution(run.id, execution), shouldCancel: () => store.isCancelRequested(run.id) }, plan.cases);
      const finished = (await store.getRun(run.id))!;
      const status = (await store.isCancelRequested(run.id)) ? "cancelled" : latestExecutions(finished).every(isGreen) && result.agents.every(agent => agent.status === "completed") ? "completed" : "failed";
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

export class NotFoundError extends Error { override name = "NotFoundError"; }
export class UsageError extends Error { override name = "UsageError"; }
export { ConfigError };
