import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { loadConfig, locateProject, type ProjectLocation } from "./config.js";
import { SqliteStore } from "./store.js";
import { launchBrowser } from "../browser-runtime/runner.js";

type Check = { name: string; status: "passed" | "failed" | "warning"; detail: string };
const message = (error: unknown) => error instanceof Error ? error.message.split("\n")[0] : String(error);

/** Preflight checks. Failures mean a run cannot succeed; warnings mean it may produce misleading results. */
export async function runDoctor(location: ProjectLocation = locateProject(), options: { launchBrowser?: boolean; probeTarget?: boolean } = {}) {
  const checks: Check[] = [];
  const [major, minor] = process.versions.node.split(".").map(Number);
  checks.push(major > 22 || (major === 22 && minor >= 13) ? { name: "node", status: "passed", detail: process.version } : { name: "node", status: "failed", detail: `${process.version}; Node 22.13 or newer is required for node:sqlite` });

  let config;
  try { config = await loadConfig(location.configPath, location.root); checks.push({ name: "configuration", status: "passed", detail: `${config.name} (${location.configPath})` }); }
  catch (error) { checks.push({ name: "configuration", status: "failed", detail: message(error) }); return { schemaVersion: 1, ok: false, checks }; }

  try { const store = new SqliteStore(join(config.artifactsDir, "testswarm.db")); store.close(); checks.push({ name: "sqlite", status: "passed", detail: "Database opened and migrated" }); }
  catch (error) { checks.push({ name: "sqlite", status: "failed", detail: message(error) }); }

  try { const probe = join(config.artifactsDir, `.doctor-${randomUUID()}`); await mkdir(config.artifactsDir, { recursive: true }); await writeFile(probe, "ok"); await rm(probe); checks.push({ name: "artifacts-writable", status: "passed", detail: config.artifactsDir }); }
  catch (error) { checks.push({ name: "artifacts-writable", status: "failed", detail: message(error) }); }

  if (config.target.storageStatePath) {
    try { await access(config.target.storageStatePath); checks.push({ name: "storage-state", status: "passed", detail: config.target.storageStatePath }); }
    catch { checks.push({ name: "storage-state", status: "failed", detail: `Missing storage state: ${config.target.storageStatePath}` }); }
  }

  if (options.launchBrowser !== false) {
    try { const browser = await launchBrowser(config.target); const version = browser.version(); await browser.close(); checks.push({ name: "browser", status: "passed", detail: `${config.target.browser} ${version}${config.target.executablePath ? ` (${config.target.executablePath})` : ""}` }); }
    catch (error) { checks.push({ name: "browser", status: "failed", detail: `${message(error)}. Run "npx playwright install ${config.target.browser}" or set target.executablePath / TESTSWARM_BROWSER_PATH.` }); }
  }

  if (options.probeTarget !== false) {
    try { const response = await fetch(config.target.baseUrl, { signal: AbortSignal.timeout(5000), redirect: "manual" }); checks.push({ name: "target-reachable", status: response.status < 500 ? "passed" : "warning", detail: `${config.target.baseUrl} responded HTTP ${response.status}` }); }
    catch (error) { checks.push({ name: "target-reachable", status: "warning", detail: `${config.target.baseUrl} is not reachable: ${message((error as Error & { cause?: unknown }).cause ?? error)}` }); }
  }

  try { await access(config.target.visualBaselinesDir!); checks.push({ name: "visual-baselines", status: "passed", detail: config.target.visualBaselinesDir! }); }
  catch { checks.push({ name: "visual-baselines", status: "warning", detail: `No baselines yet; UI cases will be "blocked" until you approve some with "testswarm baseline <run-id>"` }); }

  if (config.policy.allowExternalNetwork) checks.push({ name: "policy", status: "warning", detail: "policy.allowExternalNetwork is on: third-party subresources will load during tests" });
  if (config.policy.allowDestructiveActions) checks.push({ name: "policy", status: "warning", detail: "policy.allowDestructiveActions is on: cases marked destructive will execute" });
  return { schemaVersion: 1, ok: checks.every(check => check.status !== "failed"), checks };
}
