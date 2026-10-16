#!/usr/bin/env node
import { Engine } from "../core/engine.js";
const [command, id] = process.argv.slice(2); const engine = new Engine();
async function main() {
  if (command === "init") { const fs = await import("node:fs/promises"); try { await fs.access("testswarm.config.json"); } catch { await fs.writeFile("testswarm.config.json", JSON.stringify({ schemaVersion: 1, name: "local-app", artifactsDir: ".testswarm", target: { baseUrl: "http://127.0.0.1:3000", allowedOrigins: ["http://127.0.0.1:3000"], startPath: "/", browser: "chromium", actionTimeoutMs: 10000, navigationTimeoutMs: 30000, viewport: { width: 1280, height: 720 } } }, null, 2)); } console.log("Initialized testswarm.config.json"); return; }
  if (command === "inspect") { console.log(JSON.stringify(await engine.inspect(), null, 2)); return; }
  if (command === "plan") { console.log(JSON.stringify(await engine.plan(), null, 2)); return; }
  if (command === "plan-discovered") { console.log(JSON.stringify(await engine.planFromDiscovery(), null, 2)); return; }
  if (command === "run") { if (!id) throw new Error("Usage: testswarm run <plan-id>"); console.log(JSON.stringify(await engine.run(id), null, 2)); return; }
  if (command === "status") { if (!id) throw new Error("Usage: testswarm status <run-id>"); console.log(JSON.stringify(await engine.status(id), null, 2)); return; }
  if (command === "runs") { console.log(JSON.stringify(await engine.runs(), null, 2)); return; }
  if (command === "discover") { console.log(JSON.stringify(await engine.discover(), null, 2)); return; }
  if (command === "report") { if (!id) throw new Error("Usage: testswarm report <run-id>"); console.log(JSON.stringify(await engine.report(id), null, 2)); return; }
  if (command === "results") { if (!id) throw new Error("Usage: testswarm results <run-id>"); console.log(JSON.stringify(await engine.results(id), null, 2)); return; }
  if (command === "evidence") { if (!id) throw new Error("Usage: testswarm evidence <run-id>"); console.log(JSON.stringify(await engine.evidence(id), null, 2)); return; }
  if (command === "verify") { if (!id) throw new Error("Usage: testswarm verify <run-id>"); console.log(JSON.stringify(await engine.verify(id), null, 2)); return; }
  if (command === "retest") { if (!id) throw new Error("Usage: testswarm retest <run-id>"); console.log(JSON.stringify(await engine.retest(id), null, 2)); return; }
  if (command === "export") { if (!id) throw new Error("Usage: testswarm export <plan-id>"); console.log(JSON.stringify(await engine.exportPlan(id), null, 2)); return; }
  if (command === "cancel") { if (!id) throw new Error("Usage: testswarm cancel <run-id>"); console.log(JSON.stringify(await engine.cancel(id), null, 2)); return; }
  throw new Error("Commands: init, inspect, discover, plan, plan-discovered, run <plan-id>, status <run-id>, runs, results <run-id>, evidence <run-id>, verify <run-id>, retest <run-id>, report <run-id>, export <plan-id>, cancel <run-id>");
}
main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
