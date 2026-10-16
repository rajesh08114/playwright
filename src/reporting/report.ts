import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { RunReport, TestRun, TestPlan, TestExecution } from "../core/contracts.js";
import { classifyFailures } from "../verification/verifier.js";

export function summarize(executions: TestExecution[]) {
  const count = (outcome: TestExecution["outcome"]) => executions.filter(item => item.outcome === outcome).length;
  return { total: executions.length, passed: count("passed"), failed: count("failed"), flaky: count("flaky"), blocked: count("blocked"), infrastructure: count("infrastructure_failure") };
}

export function buildReport(run: TestRun, plan: TestPlan): RunReport {
  return { schemaVersion: 1, runId: run.id, generatedAt: new Date().toISOString(), summary: summarize(run.executions), executions: run.executions, findings: classifyFailures(run, plan) };
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
// XML 1.0 forbids most control characters even when escaped.
const escapeXml = (value: string) => escapeHtml(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
const seconds = (execution: TestExecution) => Math.max(0, (Date.parse(execution.finishedAt) - Date.parse(execution.startedAt)) / 1000).toFixed(3);

export async function writeReport(report: RunReport, directory: string, plan?: TestPlan) {
  await mkdir(directory, { recursive: true });
  const json = join(directory, `${report.runId}.json`), html = join(directory, `${report.runId}.html`), junit = join(directory, `${report.runId}.xml`);
  const cases = new Map(plan?.cases.map(item => [item.id, item]) ?? []);
  await writeFile(json, JSON.stringify(report, null, 2));

  const link = (path: string) => encodeURI(relative(directory, path).split("\\").join("/"));
  const rows = report.executions.map(execution => {
    const testCase = cases.get(execution.testCaseId);
    const evidence = execution.evidence.map(item => `<a href="${escapeHtml(link(item.path))}">${escapeHtml(item.kind)}</a>`).join(" ");
    const thumb = execution.evidence.find(item => item.kind === "screenshot");
    return `<tr class="${escapeHtml(execution.outcome)}"><td><code>${escapeHtml(execution.testCaseId)}</code><div class="muted">${escapeHtml(testCase?.title ?? "")}</div></td><td>${escapeHtml(execution.viewportProfile ?? "default")}</td><td><span class="badge">${escapeHtml(execution.outcome)}</span></td><td>${escapeHtml(execution.error ?? "")}</td><td>${thumb ? `<a href="${escapeHtml(link(thumb.path))}"><img loading="lazy" alt="" src="${escapeHtml(link(thumb.path))}"></a>` : ""}<div>${evidence}</div></td></tr>`;
  }).join("\n");
  const s = report.summary;
  await writeFile(html, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TestSwarm run ${escapeHtml(report.runId)}</title>
<style>body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#1b1b1f;background:#fff}h1{font-size:20px}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #e3e3e8;padding:8px;text-align:left;vertical-align:top}img{max-width:160px;max-height:120px;border:1px solid #ddd}.muted{color:#666;font-size:12px}.badge{padding:2px 8px;border-radius:10px;background:#eee}.passed .badge{background:#d8f5e1}.failed .badge,.infrastructure_failure .badge{background:#fde0de}.flaky .badge,.blocked .badge,.inconclusive .badge{background:#fff1c9}code{font-size:12px}</style></head>
<body><main><h1>TestSwarm run <code>${escapeHtml(report.runId)}</code></h1><p>${s.total} executions: ${s.passed} passed, ${s.failed} failed, ${s.flaky} flaky, ${s.blocked} blocked, ${s.infrastructure} infrastructure. Generated ${escapeHtml(report.generatedAt)}.</p>
<table><thead><tr><th>Case</th><th>Viewport</th><th>Outcome</th><th>Detail</th><th>Evidence</th></tr></thead><tbody>
${rows}
</tbody></table></main></body></html>`);

  const testcases = report.executions.map(execution => {
    const testCase = cases.get(execution.testCaseId);
    const name = escapeXml(`${execution.testCaseId} [${execution.viewportProfile ?? "default"}]`), classname = escapeXml(`testswarm.${testCase?.category ?? "case"}`);
    const message = escapeXml(execution.error ?? execution.outcome);
    const body = execution.outcome === "failed" ? `<failure message="${message}" type="assertion"/>`
      : execution.outcome === "infrastructure_failure" ? `<error message="${message}" type="infrastructure"/>`
      : ["blocked", "inconclusive"].includes(execution.outcome) ? `<skipped message="${message}"/>`
      : execution.outcome === "flaky" ? `<system-out>${message}</system-out>` : "";
    return `  <testcase name="${name}" classname="${classname}" time="${seconds(execution)}">${body}</testcase>`;
  }).join("\n");
  const skipped = report.executions.filter(item => ["blocked", "inconclusive"].includes(item.outcome)).length;
  await writeFile(junit, `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="testswarm" tests="${s.total}" failures="${s.failed}" errors="${s.infrastructure}" skipped="${skipped}" timestamp="${escapeXml(report.generatedAt)}">\n${testcases}\n</testsuite>\n`);
  return { json, html, junit };
}
