#!/usr/bin/env node
// Starts the TestSwarm MCP server from a source checkout. Builds first when dist/ is missing or older than src/, so a
// fresh clone or a `git pull` never leaves the MCP client with a server that fails to start. All build output goes to
// stderr: stdout belongs to the MCP protocol.
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "dist", "src", "mcp-server", "index.js");

function newestMtime(dir) {
  let newest = 0;
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    newest = Math.max(newest, item.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs);
  }
  return newest;
}

const stale = !existsSync(entry) || newestMtime(join(root, "src")) > statSync(entry).mtimeMs;
if (stale) {
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(tsc)) {
    process.stderr.write(`TestSwarm MCP: dependencies are not installed. Run "npm install" in ${root}, then restart the MCP server.\n`);
    process.exit(1);
  }
  process.stderr.write("TestSwarm MCP: building...\n");
  const build = spawnSync(process.execPath, [tsc, "-p", join(root, "tsconfig.json")], { cwd: root, stdio: ["ignore", process.stderr, process.stderr] });
  if (build.status !== 0) {
    process.stderr.write(`TestSwarm MCP: build failed (exit ${build.status}). Run "npm run build" in ${root} to see the errors.\n`);
    process.exit(1);
  }
}
await import(pathToFileURL(entry).href);
