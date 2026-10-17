import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));

test("Claude and Cursor workspace MCP configs point at the shared server", async () => {
  assert.deepEqual((await json(".mcp.json")).mcpServers.testswarm.args, ["scripts/mcp.mjs"]);
  assert.deepEqual((await json(".cursor/mcp.json")).mcpServers.testswarm.args, ["scripts/mcp.mjs"]);
});

test("plugin manifest, marketplace, and plugin MCP config agree with the package", async () => {
  const pkg = await json("package.json"), plugin = await json("plugin/.claude-plugin/plugin.json"), marketplace = await json(".claude-plugin/marketplace.json"), mcp = await json("plugin/.mcp.json");
  assert.equal(plugin.version, pkg.version, "plugin version tracks the package version");
  assert.equal(marketplace.plugins[0].source, "./plugin");
  assert.ok(mcp.mcpServers.testswarm.args.includes(`${pkg.name}@${pkg.version}`), "plugin pins the matching npm release");
  assert.ok(Object.keys(pkg.bin).includes("testswarm-mcp"));
  // Normalise line endings: Windows checkouts may convert LF to CRLF.
  const skill = (await readFile("plugin/skills/browser-testing/SKILL.md", "utf8")).replace(/\r\n/g, "\n");
  assert.match(skill, /^---\nname: browser-testing\ndescription: .+\n---/);
});
