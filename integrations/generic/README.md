# Generic MCP integration

The universal integration is the local stdio MCP server. Build first with `npm run build`, then configure the MCP client to launch:

```json
{
  "mcpServers": {
    "testswarm": {
      "command": "node",
      "args": ["/absolute/path/to/testswarm-ai/dist/src/mcp-server/index.js"]
    }
  }
}
```

This configuration has not been validated against a specific external host in this repository.
