# Risks and limitations

- The first runner executes a deterministic heading assertion; it does not yet interpret arbitrary generated steps.
- SQLite uses Node's built-in `node:sqlite` API and therefore requires Node 22.5+.
- MCP currently exposes plan/run/status only; remaining tools require the lifecycle and evidence/reporting services.
- No host integration is claimed as verified because no host environment was available.
- Playwright browser binaries may need installation with `npx playwright install chromium`; the controlled demo server starts, but the browser smoke test remains environment-blocked until that binary is available.
