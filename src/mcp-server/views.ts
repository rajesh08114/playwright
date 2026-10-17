import { readFile } from "node:fs/promises";
import { PNG } from "pngjs";
import type { TestPlan, TestRun } from "../core/contracts.js";
import { latestExecutions, nextSteps } from "../core/engine.js";
import { navigationPath } from "../browser-runtime/runner.js";
import { summarize } from "../reporting/report.js";

// MCP responses land in an assistant's context window, so tools return compact views; details are one call away.

export function planView(plan: TestPlan) {
  const byCategory: Record<string, number> = {};
  for (const item of plan.cases) byCategory[item.category] = (byCategory[item.category] ?? 0) + 1;
  return {
    planId: plan.id,
    cases: plan.cases.length,
    byCategory,
    routes: [...new Set(plan.cases.filter(item => item.category !== "journey").map(item => navigationPath(item, "/")))],
    journeys: plan.cases.filter(item => item.category === "journey").map(item => ({ id: item.id, title: item.title, origin: item.origin, destructive: item.destructive })),
    next: `Call testswarm_run with planId ${plan.id}. Use testswarm_get_plan to see every case.`
  };
}

export function runView(run: TestRun, options: { includePassed?: boolean; limit?: number } = {}) {
  const latest = latestExecutions(run);
  const shown = latest.filter(item => options.includePassed || !["passed"].includes(item.outcome)).slice(0, options.limit ?? 50);
  return {
    runId: run.id,
    planId: run.planId,
    status: run.status,
    summary: summarize(latest),
    nextSteps: nextSteps(run),
    ...(run.error ? { error: run.error } : {}),
    executions: shown.map(item => ({
      testCaseId: item.testCaseId,
      viewport: item.viewportProfile ?? "default",
      outcome: item.outcome,
      ...(item.error ? { error: item.error.slice(0, 500) } : {}),
      evidence: item.evidence.map(evidence => evidence.kind).filter((kind, index, all) => all.indexOf(kind) === index)
    })),
    ...(shown.length < latest.length ? { omitted: `${latest.length - shown.length} more execution(s); pass includePassed or a higher limit to see them` } : {}),
    tip: "testswarm_screenshot shows what the page looked like for any case."
  };
}

const MAX_IMAGE_HEIGHT = 2400;

/** Reads a screenshot and crops very tall full-page captures so they stay legible and within image size limits. */
export async function screenshotImage(path: string): Promise<{ data: string; note?: string }> {
  const bytes = await readFile(path);
  const png = PNG.sync.read(bytes);
  if (png.height <= MAX_IMAGE_HEIGHT) return { data: bytes.toString("base64") };
  const cropped = new PNG({ width: png.width, height: MAX_IMAGE_HEIGHT });
  PNG.bitblt(png, cropped, 0, 0, png.width, MAX_IMAGE_HEIGHT, 0, 0);
  return { data: PNG.sync.write(cropped).toString("base64"), note: `Cropped to the top ${MAX_IMAGE_HEIGHT}px of a ${png.height}px page. Full image: ${path}` };
}
