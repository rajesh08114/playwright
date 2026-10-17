#!/usr/bin/env node
import "../core/quiet-warnings.js";
import { parseArgs } from "node:util";
import { ConfigError, Engine, NotFoundError, UsageError, latestExecutions, nextSteps } from "../core/engine.js";
import { summarize } from "../reporting/report.js";
import { VERSION } from "../core/version.js";
import { installBrowser } from "../browser-runtime/browsers.js";
import type { TestRun } from "../core/contracts.js";

const HELP = `testswarm ${VERSION} - local-first browser testing engine built on Playwright

Usage: testswarm <command> [arguments] [options]

Setup
  init [--base-url <url>]          Write a starter testswarm.config.json
  inspect                          Print the validated configuration
  doctor                           Check Node, config, storage, browser, and target
  install-browser [--with-deps]    Download the browser build this Playwright version expects

Planning
  discover                         Crawl the target and list routes
  plan                             Plan from target.startPath and target.routes (no crawl)
  plan-discovered                  Crawl, then plan from discovered routes
  plan-ai                          Crawl, then add model-proposed journeys (needs llm.enabled)
  plan-agent                       Crawl, then let a deep agent explore and verify journeys (needs llm.enabled)
  login                            Run the configured login and save the session

Execution
  run <plan-id>                    Execute a plan (exit code 1 unless every case passes)
  retest <run-id>                  Re-run only the cases that did not pass, as a new run
  resume <run-id> [--force]        Continue an interrupted or failed run in place
  repeat <plan-id> [count]         Run a plan 2-10 times and report unstable cases
  cancel <run-id>                  Cancel a run, including one executing in another process
  agents <plan-id>                 Run specialist agents without persisting a run
  agent-run <plan-id>              Run specialist agents and persist the result as a run

Results
  runs [--limit n]                 List recent runs
  status <run-id>                  Show run progress and outcome counts
  results <run-id>                 Full run record with executions
  evidence <run-id>                List evidence files
  report <run-id>                  Write JSON, HTML, and JUnit reports
  verify <run-id>                  Group failures into findings
  baseline <run-id> [case-id...]   Approve UI screenshots as visual baselines
  benchmark <run-id>               Coverage and seeded-defect recall
  compare <run-a> <run-b>          Outcome deltas between two runs
  export <plan-id>                 Write an equivalent @playwright/test spec
  prune [--keep n]                 Delete old runs and their artifacts

Options
  -p, --project <dir>              Project directory (default: $TESTSWARM_PROJECT_DIR or cwd)
  -c, --config <file>              Config file relative to the project (default: testswarm.config.json)
      --json                       Machine-readable JSON output
      --headed                     Show the browser window while it works (same as TESTSWARM_HEADED=1)
  -h, --help                       Show this help
  -v, --version                    Show the version

Exit codes: 0 success, 1 test failures or failed checks, 2 usage or configuration error, 3 internal error.`;

const { values, positionals } = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        project: { type: "string", short: "p" }, config: { type: "string", short: "c" }, json: { type: "boolean" },
        help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" }, force: { type: "boolean" },
        limit: { type: "string" }, keep: { type: "string" }, "base-url": { type: "string" }, headed: { type: "boolean" }, "with-deps": { type: "boolean" }
      }
    });
  } catch (error) { console.error((error as Error).message); console.error('Run "testswarm --help" for usage.'); process.exit(2); }
})();

const [command, ...args] = positionals;
const json = Boolean(values.json);
if (values.headed) process.env.TESTSWARM_HEADED = "1";
const engine = new Engine({ projectDir: values.project, configPath: values.config });

function out(value: unknown, human?: () => string) { console.log(json || !human ? JSON.stringify(value, null, 2) : human()); }
function need(value: string | undefined, usage: string): string { if (!value) throw new UsageError(`Usage: testswarm ${usage}`); return value; }
function int(value: string | undefined, name: string, fallback?: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new UsageError(`${name} must be a non-negative integer`);
  return parsed;
}
function runSummary(run: TestRun) {
  const s = summarize(latestExecutions(run));
  const lines = [`Run ${run.id}: ${run.status}`, `  ${s.total} executions: ${s.passed} passed, ${s.failed} failed, ${s.flaky} flaky, ${s.blocked} blocked, ${s.infrastructure} infrastructure`];
  for (const step of nextSteps(run)) lines.push(`  Next: ${step}`);
  for (const execution of latestExecutions(run).filter(item => item.outcome !== "passed")) lines.push(`  ${execution.outcome.padEnd(22)} ${execution.testCaseId} [${execution.viewportProfile ?? "default"}] ${execution.error ?? ""}`.trimEnd());
  return lines.join("\n");
}
const runExitCode = (run: TestRun) => run.status === "completed" ? 0 : 1;

async function main(): Promise<number> {
  if (values.version) { console.log(VERSION); return 0; }
  if (values.help || !command || command === "help") { console.log(HELP); return command || values.help ? 0 : 2; }
  switch (command) {
    case "init": { const result = await engine.init(values["base-url"]); out(result, () => result.created ? `Created ${result.path}. Edit target.baseUrl, then run "testswarm doctor".` : `${result.path} already exists; left unchanged.`); return 0; }
    case "inspect": out(await engine.inspect()); return 0;
    case "install-browser": {
      const config = await engine.config().catch(() => undefined);
      return installBrowser(config?.target.browser ?? "chromium", { withDeps: values["with-deps"] });
    }
    case "doctor": { const result = await engine.doctor(); out(result, () => result.checks.map(check => `${check.status === "passed" ? "ok  " : check.status === "warning" ? "warn" : "FAIL"} ${check.name.padEnd(18)} ${check.detail}`).join("\n")); return result.ok ? 0 : 1; }
    case "discover": { const result = await engine.discover(); out(result, () => [`Discovered ${result.routes.length} route(s):`, ...result.routes.map(route => `  ${route.path}  ${route.heading ?? route.title ?? ""}`), ...result.warnings.map(item => `  warning: ${item}`)].join("\n")); return 0; }
    case "login": { const result = await engine.login(); out(result, () => `Logged in; session saved to ${result.storageStatePath} (reused for ${result.maxAgeMinutes} minutes).`); return 0; }
    case "plan-ai": {
      const result = await engine.planWithAi();
      out(result, () => [
        `Plan ${result.plan.id} with ${result.plan.cases.length} case(s), including ${result.proposedJourneys} model-proposed journey(s).`,
        result.blockedUntilReviewed.length ? `${result.blockedUntilReviewed.length} proposed journey(s) change page state and stay blocked until you review them and set policy.allowDestructiveActions: ${result.blockedUntilReviewed.join(", ")}` : "",
        result.rejected.length ? `${result.rejected.length} proposal(s) rejected as invalid.` : "",
        `Review: ${result.file}`,
        result.usage ? `Tokens: ${result.usage.inputTokens} in (${result.usage.cacheReadInputTokens} cached), ${result.usage.outputTokens} out on ${result.usage.model}.` : "",
        `Run it with: testswarm run ${result.plan.id}`
      ].filter(Boolean).join("\n"));
      return 0;
    }
    case "plan-agent": {
      const result = await engine.planWithAgent();
      out(result, () => [
        `Plan ${result.plan.id} with ${result.plan.cases.length} case(s), including ${result.verifiedJourneys} journey(s) the agent verified against the app.`,
        result.forReview.length ? `${result.forReview.length} journey(s) need human review (unverified or state-changing): ${result.forReview.map(item => item.id).join(", ")}` : "",
        result.findings ? `${result.findings} candidate defect(s) reported.` : "",
        `Trials: ${result.trials.passed} passed, ${result.trials.failed} failed, ${result.trials.refused} refused by policy.`,
        `Tokens: ${result.usage.inputTokens} in (${result.usage.cacheReadInputTokens} cached), ${result.usage.outputTokens} out over ${result.usage.modelCalls} model call(s).`,
        result.stoppedEarly ? `Note: ${result.stoppedEarly}; results so far were kept.` : "",
        `Review: ${result.file}`,
        `Run it with: testswarm run ${result.plan.id}`
      ].filter(Boolean).join("\n"));
      return 0;
    }
    case "plan": case "plan-discovered": { const plan = command === "plan" ? await engine.plan() : await engine.planFromDiscovery(); out(plan, () => `Plan ${plan.id} with ${plan.cases.length} case(s). Run it with: testswarm run ${plan.id}`); return 0; }
    case "run": { const run = await engine.run(need(args[0], "run <plan-id>")); out(run, () => `${runSummary(run)}\nReport: testswarm report ${run.id}`); return runExitCode(run); }
    case "retest": { const run = await engine.retest(need(args[0], "retest <run-id>")); out(run, () => runSummary(run)); return runExitCode(run); }
    case "resume": { const run = await engine.resume(need(args[0], "resume <run-id> [--force]"), { force: values.force }); out(run, () => runSummary(run)); return runExitCode(run); }
    case "repeat": { const result = await engine.repeat(need(args[0], "repeat <plan-id> [count]"), int(args[1], "count", 2)); out(result, () => `${result.requestedRuns} runs: ${result.stable ? "stable" : `${result.unstable.length} unstable case(s): ${result.unstable.join(", ")}`}`); return result.stable ? 0 : 1; }
    case "cancel": { const run = await engine.cancel(need(args[0], "cancel <run-id>")); out(run, () => `Run ${run.id}: ${run.status}`); return 0; }
    case "agents": out(await engine.agents(need(args[0], "agents <plan-id>"))); return 0;
    case "agent-run": { const result = await engine.agentRun(need(args[0], "agent-run <plan-id>")); out(result, () => runSummary(result.run)); return runExitCode(result.run); }
    case "runs": { const runs = await engine.runs(int(values.limit, "--limit", 20)); out(runs, () => runs.length ? runs.map(run => `${run.id}  ${run.status.padEnd(9)}  ${run.startedAt}  ${run.summary.passed}/${run.summary.total} passed`).join("\n") : "No runs yet."); return 0; }
    case "status": { const progress = await engine.progress(need(args[0], "status <run-id>")); out(progress, () => `Run ${progress.runId}: ${progress.status} (${progress.completedExecutions}/${progress.expectedExecutions ?? "?"} executions)\n  ${progress.summary.passed} passed, ${progress.summary.failed} failed, ${progress.summary.flaky} flaky, ${progress.summary.blocked} blocked, ${progress.summary.infrastructure} infrastructure${progress.error ? `\n  Error: ${progress.error}` : ""}${progress.hint ? `\n  ${progress.hint}` : ""}`); return 0; }
    case "results": { const run = await engine.results(need(args[0], "results <run-id>")); out(run, () => runSummary(run)); return 0; }
    case "evidence": { const items = await engine.evidence(need(args[0], "evidence <run-id>")); out(items, () => items.map(item => `${item.kind.padEnd(13)} ${item.testCaseId} [${item.viewportProfile ?? "default"}] ${item.path}`).join("\n")); return 0; }
    case "report": { const result = await engine.report(need(args[0], "report <run-id>")); out(result, () => `HTML:  ${result.files.html}\nJSON:  ${result.files.json}\nJUnit: ${result.files.junit}`); return 0; }
    case "verify": { const findings = await engine.verify(need(args[0], "verify <run-id>")); out(findings, () => findings.length ? findings.map(item => `${item.verificationState.padEnd(10)} ${item.severity.padEnd(8)} ${item.category.padEnd(13)} ${item.route}  ${item.reproduction.at(-1)}`).join("\n") : "No failures."); return 0; }
    case "baseline": { const result = await engine.baseline(need(args[0], "baseline <run-id> [case-id...]"), args.slice(1)); out(result, () => `Approved ${result.files.length} baseline(s).`); return 0; }
    case "benchmark": out(await engine.benchmark(need(args[0], "benchmark <run-id>"))); return 0;
    case "compare": out(await engine.compare(need(args[0], "compare <run-a> <run-b>"), need(args[1], "compare <run-a> <run-b>"))); return 0;
    case "export": { const result = await engine.exportPlan(need(args[0], "export <plan-id>")); out(result, () => `Wrote ${result.testCount} test(s) to ${result.file}`); return 0; }
    case "prune": { const result = await engine.prune(int(values.keep, "--keep")); out(result, () => `Removed ${result.removed.length} run(s).`); return 0; }
    default: throw new UsageError(`Unknown command "${command}". Run "testswarm --help" for usage.`);
  }
}

main().then(code => { process.exitCode = code; }, error => {
  // Login and model-provider failures are environment/configuration problems the user can fix, not internal bugs.
  const expected = error instanceof UsageError || error instanceof ConfigError || error instanceof NotFoundError || error?.name === "LoginError" || error?.name === "LlmError";
  console.error(json ? JSON.stringify({ error: { name: error?.name, message: error?.message ?? String(error) } }) : `Error: ${error?.message ?? error}`);
  if (!expected && process.env.TESTSWARM_DEBUG) console.error(error?.stack);
  process.exitCode = expected ? 2 : 3;
}).finally(() => engine.close());
