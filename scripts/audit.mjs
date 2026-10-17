#!/usr/bin/env node
// Dependency audit gate for CI. Fails on any high or critical advisory in runtime (including optional) dependencies,
// except advisories listed below with a written reason. Each entry must name why the vulnerable code is unreachable
// and how that is enforced; remove the entry as soon as a fixed version is available.
import { execFileSync } from "node:child_process";

const ALLOWED = {
  "GHSA-vfj7-8cjw-p6xm": {
    package: "braces",
    reason: "Reached only through deepagents' FilesystemBackend/LocalShellBackend (fast-glob, micromatch). TestSwarm uses the in-memory StateBackend and never constructs those backends; enforced by tests/browser/deep-agent.test.ts. No patched braces release exists yet."
  }
};
const BLOCKING = new Set(["high", "critical"]);

let raw;
try { raw = execFileSync("npm", ["audit", "--omit=dev", "--json"], { encoding: "utf8", shell: process.platform === "win32" }); }
catch (error) { raw = error.stdout; } // npm audit exits non-zero when it finds anything
const report = JSON.parse(raw);
const advisories = new Map();
for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
  for (const via of vulnerability.via) if (typeof via === "object") advisories.set(via.url, { ...via, package: vulnerability.name });
}

const blocking = [], allowed = [];
for (const advisory of advisories.values()) {
  if (!BLOCKING.has(advisory.severity)) continue;
  const id = advisory.url?.split("/").pop();
  (ALLOWED[id] ? allowed : blocking).push({ id, ...advisory });
}
for (const item of allowed) console.log(`allowed  ${item.severity.padEnd(8)} ${item.package} ${item.id}: ${ALLOWED[item.id].reason}`);
for (const item of blocking) console.error(`BLOCKING ${item.severity.padEnd(8)} ${item.package} ${item.id}: ${item.title}`);
const stale = Object.keys(ALLOWED).filter(id => !allowed.some(item => item.id === id));
for (const id of stale) console.error(`STALE    allowlist entry ${id} no longer matches any advisory; remove it from scripts/audit.mjs`);
if (blocking.length || stale.length) process.exit(1);
console.log(`audit ok: ${advisories.size} advisory(ies) total, none blocking`);
