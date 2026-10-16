# Claude Code adapter

Two options:

- **Working in this repository:** the project-scoped `.mcp.json` launches the local build (`npm run build` first). Approve the `testswarm` server when Claude Code prompts.
- **Any project (plugin):** `plugin/` is a Claude Code plugin bundling the MCP server (via `npx -p testswarm-ai@<version> testswarm-mcp`) and a `browser-testing` skill. Once the package is published to npm:

  ```text
  /plugin marketplace add rajesh08114/playwright
  /plugin install testswarm@testswarm
  ```

  The server reads `testswarm.config.json` from the directory Claude Code launches it in (the project), or from `TESTSWARM_PROJECT_DIR`. Ask Claude to "set up TestSwarm for http://localhost:3000" to create one.
