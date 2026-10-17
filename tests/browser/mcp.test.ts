import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tempProject, targetFor } from "../helpers.js";

const serverPath = fileURLToPath(new URL("../../src/mcp-server/index.js", import.meta.url));

test("MCP server lists tools, answers calls, and reports errors as tool errors", async () => {
  const dir = await tempProject({ target: targetFor("http://127.0.0.1:3999") });
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { ...process.env, TESTSWARM_PROJECT_DIR: dir } as Record<string, string>, stderr: "pipe" });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    for (const name of ["testswarm_doctor", "testswarm_run", "testswarm_status", "testswarm_baseline", "testswarm_login", "testswarm_plan_with_ai"]) assert.ok(tools.some(item => item.name === name), name);
    assert.equal(tools.find(item => item.name === "testswarm_status")?.annotations?.readOnlyHint, true);
    const plan = await client.callTool({ name: "testswarm_plan", arguments: {} });
    assert.equal(plan.isError, undefined);
    const planId = JSON.parse((plan.content as Array<{ text: string }>)[0].text).id;
    assert.ok(planId);
    const missing = await client.callTool({ name: "testswarm_status", arguments: { runId: "nope" } });
    assert.equal(missing.isError, true);
    assert.match((missing.content as Array<{ text: string }>)[0].text, /Run not found/);
  } finally { await client.close(); }
});
