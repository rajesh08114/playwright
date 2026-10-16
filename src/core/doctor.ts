import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { loadConfig } from "./config.js";
import { SqliteStore } from "./store.js";

export async function runDoctor() {
  const checks: Array<{ name: string; status: "passed" | "failed" | "warning"; detail: string }> = [];
  let config;
  try { config = await loadConfig(); checks.push({ name: "configuration", status: "passed", detail: `${config.name} is valid` }); } catch (error) { checks.push({ name: "configuration", status: "failed", detail: error instanceof Error ? error.message : String(error) }); return { schemaVersion: 1, ok: false, checks }; }
  try { const store = new SqliteStore(); store.close(); checks.push({ name: "sqlite", status: "passed", detail: "SQLite database opened with schema" }); } catch (error) { checks.push({ name: "sqlite", status: "failed", detail: error instanceof Error ? error.message : String(error) }); }
  try { const probe = `${config.artifactsDir}/.doctor-${randomUUID()}`; await mkdir(dirname(probe), { recursive: true }); await writeFile(probe, "ok"); await rm(probe); checks.push({ name: "artifacts-writable", status: "passed", detail: config.artifactsDir }); } catch (error) { checks.push({ name: "artifacts-writable", status: "failed", detail: error instanceof Error ? error.message : String(error) }); }
  if (config.target.executablePath) { try { await access(config.target.executablePath); checks.push({ name: "browser-executable", status: "passed", detail: config.target.executablePath }); } catch { checks.push({ name: "browser-executable", status: "failed", detail: `Missing executable: ${config.target.executablePath}` }); } } else checks.push({ name: "browser-executable", status: "warning", detail: "Using Playwright's managed browser lookup" });
  try { await import("@modelcontextprotocol/sdk/server/mcp.js"); checks.push({ name: "mcp-sdk", status: "passed", detail: "MCP SDK import succeeded" }); } catch (error) { checks.push({ name: "mcp-sdk", status: "failed", detail: error instanceof Error ? error.message : String(error) }); }
  return { schemaVersion: 1, ok: checks.every(check => check.status !== "failed"), checks };
}
