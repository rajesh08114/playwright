import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Claude and Cursor workspace MCP configs point at the shared server", async () => {
  const claude = JSON.parse(await readFile(".mcp.json", "utf8"));
  const cursor = JSON.parse(await readFile(".cursor/mcp.json", "utf8"));
  assert.deepEqual(claude.mcpServers.testswarm.args, ["dist/src/mcp-server/index.js"]);
  assert.deepEqual(cursor.mcpServers.testswarm.args, ["dist/src/mcp-server/index.js"]);
});
