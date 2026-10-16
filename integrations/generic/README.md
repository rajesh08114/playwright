# Generic MCP integration

TestSwarm is a stdio MCP server. Configure your client to launch it with the project directory in `TESTSWARM_PROJECT_DIR`:

```json
{
  "mcpServers": {
    "testswarm": {
      "command": "npx",
      "args": ["-y", "-p", "testswarm-ai@0.1.0", "testswarm-mcp"],
      "env": { "TESTSWARM_PROJECT_DIR": "/absolute/path/to/your/project" }
    }
  }
}
```

From a source checkout, use `"command": "node", "args": ["/absolute/path/to/testswarm/dist/src/mcp-server/index.js"]` after `npm run build`.

`testswarm_run` returns a `runId` immediately; poll `testswarm_status`. Pass `"wait": true` only for small plans, since long tool calls may exceed client timeouts.
