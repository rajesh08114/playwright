import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { TestRun } from "./contracts.js";
import { Store, SqliteStore } from "./store.js";
import { createStarterPlan, createPlanFromDiscovery } from "../planner/planner.js";
import { executeCaseWithRetry } from "../browser-runtime/runner.js";
import { discoverApplication } from "../discovery/discover.js";
import { buildReport, writeReport } from "../reporting/report.js";
import { classifyFailures } from "../verification/verifier.js";
import { mkdir, writeFile } from "node:fs/promises";
export class Engine {
  private readonly cancellations = new Set<string>();
  constructor(private readonly store: Store = new SqliteStore()) {}
  async plan() { const p = createStarterPlan(); await this.store.putPlan(p); return p; }
  async run(planId: string) {
    const config = await loadConfig(), plan = await this.store.getPlan(planId); if (!plan) throw new Error(`Plan not found: ${planId}`);
    const run: TestRun = { id: randomUUID(), projectName: config.name, planId, status: "running", startedAt: new Date().toISOString(), executions: [] }; await this.store.putRun(run);
    const profiles = config.target.viewportProfiles.length ? config.target.viewportProfiles : [{ name: "default", width: config.target.viewport.width, height: config.target.viewport.height }];
    for (const testCase of plan.cases) {
      if (this.cancellations.has(run.id)) { run.status = "cancelled"; break; }
      for (const profile of profiles) {
        if (this.cancellations.has(run.id)) { run.status = "cancelled"; break; }
        const execution = await executeCaseWithRetry({ ...config.target, viewport: { width: profile.width, height: profile.height } }, testCase, `${config.artifactsDir}/runs/${run.id}/${profile.name}`, config.budgets.maxRetries); execution.viewportProfile = profile.name; run.executions.push(execution); await this.store.putRun(run);
      }
    }
    if (run.status === "cancelled" || this.cancellations.has(run.id)) { run.status = "cancelled"; run.finishedAt = new Date().toISOString(); await this.store.putRun(run); return run; }
    run.status = run.executions.every(x => x.outcome === "passed") ? "completed" : "failed"; run.finishedAt = new Date().toISOString(); await this.store.putRun(run); return run;
  }
  async status(id: string) { const run = await this.store.getRun(id); if (!run) throw new Error(`Run not found: ${id}`); return run; }
  async cancel(id: string) { const run = await this.status(id); if (["completed", "failed", "cancelled"].includes(run.status)) return run; this.cancellations.add(id); run.status = "cancelled"; run.finishedAt = new Date().toISOString(); await this.store.putRun(run); return run; }
  async runs() { return this.store.listRuns(); }
  async discover() { const config = await loadConfig(); return discoverApplication(config.target); }
  async planFromDiscovery() { const plan = createPlanFromDiscovery(await this.discover()); await this.store.putPlan(plan); return plan; }
  async report(runId: string) { const config = await loadConfig(), run = await this.status(runId), plan = await this.store.getPlan(run.planId); if (!plan) throw new Error(`Plan not found: ${run.planId}`); const report = buildReport(run, plan); return { report, files: await writeReport(report, `${config.artifactsDir}/reports`) }; }
  async inspect() { return loadConfig(); }
  async results(runId: string) { return this.status(runId); }
  async evidence(runId: string) { const run = await this.status(runId); return run.executions.flatMap(execution => execution.evidence.map(item => ({ ...item, executionId: execution.id, testCaseId: execution.testCaseId }))); }
  async verify(runId: string) { const run = await this.status(runId), plan = await this.store.getPlan(run.planId); if (!plan) throw new Error(`Plan not found: ${run.planId}`); return classifyFailures(run, plan); }
  async retest(runId: string) { const run = await this.status(runId); return this.run(run.planId); }
  async exportPlan(planId: string) { const plan = await this.store.getPlan(planId); if (!plan) throw new Error(`Plan not found: ${planId}`); const config = await loadConfig(), directory = `${config.artifactsDir}/exports`; await mkdir(directory, { recursive: true }); const file = `${directory}/${plan.id}.spec.ts`; const source = `import { test, expect } from "@playwright/test";\n\n${plan.cases.map(testCase => `test(${JSON.stringify(testCase.title)}, async ({ page }) => {\n  await page.goto(${JSON.stringify(testCase.steps[0]?.replace(/^Navigate to /, "") ?? "/")});\n  await expect(page.getByRole("heading").first()).toBeVisible();\n});`).join("\n\n")}`; await writeFile(file, source); return { file, testCount: plan.cases.length }; }
}
