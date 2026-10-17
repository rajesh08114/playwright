# TestSwarm AI

TestSwarm is a local-first browser testing engine built on Playwright. It crawls the routes of a web application, plans deterministic checks for each route, runs them in a real browser across viewport profiles, stores results in SQLite, captures evidence (screenshots, traces, axe results, console and network logs), and writes HTML, JSON, and JUnit reports. It is usable as a CLI, as an MCP server, and as a Claude Code plugin.

What each route is checked for:

| Category | Check | Fails when |
| --- | --- | --- |
| functional | Page loads, heading visible | HTTP status >= 400, no visible heading, console errors (configurable), failed same-origin requests |
| accessibility | axe-core scan | Any violation at or above `policy.accessibilityFailOn` (default `serious`) |
| responsive | Document width per viewport | Horizontal overflow |
| ui | Full-page screenshot vs. approved baseline | Changed pixels exceed `policy.visualMaxDiffRatio`; **blocked** (not passed) until a baseline is approved |

TestSwarm does not replace application-specific test design, security testing, or human release approval. It never submits forms, never follows links that look state-changing (logout, delete, ...), and never navigates outside `target.allowedOrigins`.

## Requirements

- Node.js 22.13 or newer (uses the built-in `node:sqlite`).
- A Playwright browser: `npx playwright install chromium`, or point `target.executablePath` / `TESTSWARM_BROWSER_PATH` at an existing Chromium.

## Quick start

```sh
npm install
npm run build
npx playwright install chromium

# In another terminal: a demo target (add TESTSWARM_SEEDED_DEFECTS=1 for deliberate defects)
npm run demo

node dist/src/cli/index.js init --base-url http://127.0.0.1:3000
node dist/src/cli/index.js doctor
node dist/src/cli/index.js plan-discovered          # prints a plan id
node dist/src/cli/index.js run <plan-id>            # exit code 1 until everything passes
node dist/src/cli/index.js report <run-id>          # HTML, JSON, and JUnit paths
```

On the first run every UI case is `blocked` because no visual baselines exist. Open the screenshots (`testswarm evidence <run-id>` or the HTML report), and when they are correct approve them with `testswarm baseline <run-id>`. Later runs compare against them.

Once published to npm, the same commands are available as `npx testswarm ...`.

## CLI

```text
testswarm <command> [arguments] [--project <dir>] [--config <file>] [--json]
```

| Command | Purpose |
| --- | --- |
| `init [--base-url <url>]` | Write a starter `testswarm.config.json` |
| `inspect` | Print the validated configuration |
| `doctor` | Check Node, configuration, storage, browser launch, target reachability |
| `discover` | Crawl and list routes |
| `plan` | Plan from `target.startPath` + `target.routes` (no crawl) |
| `plan-discovered` | Crawl, then plan |
| `run <plan-id>` | Execute a plan |
| `retest <run-id>` | Re-run only what did not pass, as a new run |
| `resume <run-id> [--force]` | Continue an interrupted, failed, or cancelled run in place |
| `repeat <plan-id> [count]` | Run 2-10 times and list unstable cases |
| `cancel <run-id>` | Cancel a run, including one executing in another process |
| `runs`, `status`, `results`, `evidence` | Inspect runs |
| `report <run-id>` | Write HTML, JSON, and JUnit reports |
| `verify <run-id>` | Group failures into findings (`probable` when a case fails on every viewport) |
| `baseline <run-id> [case-id...]` | Approve UI screenshots as visual baselines |
| `benchmark <run-id>`, `compare <a> <b>` | Coverage, seeded-defect recall, run deltas |
| `export <plan-id>` | Write an equivalent standalone `@playwright/test` spec |
| `agents`, `agent-run <plan-id>` | Run the category-scoped specialist executors |
| `prune [--keep n]` | Delete old runs and their artifacts (default `policy.retainRuns`) |

Exit codes: `0` success, `1` test failures or failed checks, `2` usage or configuration error, `3` internal error. Output is human-readable by default; `--json` prints machine-readable JSON.

### CI usage

```sh
npx playwright install --with-deps chromium
npx testswarm doctor
PLAN=$(npx testswarm plan --json | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).id))")
npx testswarm run "$PLAN"; STATUS=$?
npx testswarm report "$(npx testswarm runs --json --limit 1 | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d)[0].id))")"
exit $STATUS
```

Commit approved baselines (`target.visualBaselinesDir`) if you want CI to check visuals, and publish the JUnit XML from `.testswarm/reports/` to your CI's test view. Baselines are browser- and OS-specific; approve them on the same platform CI runs on.

## Configuration

`testswarm.config.json` in the project directory (override with `--project` / `TESTSWARM_PROJECT_DIR` and `--config` / `TESTSWARM_CONFIG`). Relative paths resolve against the project directory. See `testswarm.config.example.json`.

| Key | Default | Meaning |
| --- | --- | --- |
| `target.baseUrl` | required | Origin of the application under test |
| `target.allowedOrigins` | required | Origins the browser may load; must include `baseUrl`. Cloud metadata and unspecified addresses are rejected |
| `target.startPath` | required | Where discovery starts |
| `target.routes` | `[]` | Extra routes to plan and crawl (in addition to links and `sitemap.xml`) |
| `target.browser` | `chromium` | `chromium`, `firefox`, or `webkit` |
| `target.executablePath` | managed | Browser binary; falls back to `TESTSWARM_BROWSER_PATH`, then Playwright's managed browser |
| `target.viewportProfiles` | `[]` | Named viewports; every case runs once per profile (or once at `target.viewport`) |
| `target.storageStatePath` | none | Playwright storage-state file for authenticated pages |
| `target.visualBaselinesDir` | `<artifactsDir>/visual-baselines` | Where approved baselines live |
| `budgets.maxRoutes` | 25 | Discovery page limit |
| `budgets.maxCases` | 100 | Plan size limit |
| `budgets.maxRetries` | 1 | Retries for failed cases; a pass after a retry is reported `flaky` |
| `budgets.maxConcurrency` | 1 | Parallel workers, each with its own browser |
| `policy.accessibilityFailOn` | `serious` | Lowest axe impact that fails a case |
| `policy.failOnConsoleErrors` | `true` | Console errors fail functional cases |
| `policy.visualMaxDiffRatio` | `0.001` | Fraction of pixels allowed to differ |
| `policy.maskSelectors` | `[]` | CSS selectors masked in screenshots (dynamic or sensitive content) |
| `policy.trace` | `retain-on-failure` | `off`, `on`, or `retain-on-failure` Playwright traces |
| `policy.retainRuns` | 50 | Runs kept by `prune` |
| `policy.allowExternalNetwork` | `false` | Allow third-party subresources (top-level navigation stays restricted) |
| `policy.allowDestructiveActions` | `false` | Allow cases marked `reversible` / `destructive` |
| `policy.redactSecrets` | `true` | Redact tokens, cookies, and keys from console and network evidence |
| `testData` | none | HTTP setup/cleanup endpoints called around each run (must be allowed origins) |

## MCP server and Claude Code plugin

`npm run mcp` (or `testswarm-mcp` once installed) starts a stdio MCP server exposing `testswarm_*` tools. Long operations return immediately: `testswarm_run` returns a `runId`; poll `testswarm_status`. Tool errors are returned as MCP tool errors, and tools carry read-only/destructive hints. The server uses `TESTSWARM_PROJECT_DIR` if set, otherwise the directory the client launches it in.

- **This repository:** `.mcp.json` (Claude Code) and `.cursor/mcp.json` (Cursor) run the local build.
- **Claude Code plugin:** `plugin/` contains the plugin (MCP server + a `browser-testing` skill that teaches the plan → run → poll → review → retest loop and forbids self-approving baselines). After the package is published to npm, install with:

  ```text
  /plugin marketplace add rajesh08114/playwright
  /plugin install testswarm@testswarm
  ```

- **Other MCP clients:** see `integrations/generic/README.md`.

## Generated data and security

Everything is written under `artifactsDir` (default `.testswarm/`): the SQLite database (`0600`), run artifacts, reports, traces, baselines, and benchmarks. Treat it as sensitive: screenshots and traces can contain whatever the page shows. Use `policy.maskSelectors` for sensitive regions, keep storage-state files out of version control, and `prune` regularly. Details in `docs/security/review.md`.

## Development

```sh
npm run lint          # type check
npm test              # build + all tests (browser tests need Chromium)
npm run test:unit     # no browser required
```

Set `TESTSWARM_BROWSER_PATH` to use an existing Chromium in tests. Layout:

```text
src/core/              contracts, config, engine, SQLite store, doctor
src/browser-runtime/   Playwright execution, checks, and evidence capture
src/discovery/         same-origin crawler
src/planner/           deterministic case generation
src/reporting/         HTML / JSON / JUnit
src/verification/      failure grouping into findings
src/agents/            category-scoped specialist executors
src/benchmarks/        coverage, recall, run comparison
src/mcp-server/        MCP stdio server
src/cli/               command-line interface
plugin/                Claude Code plugin (manifest, MCP config, skill)
tests/unit, adapters   fast tests; tests/browser: Playwright-backed tests
fixtures/demo-app/     demo target with optional seeded defects
```

## Status and license

Version 0.1.0. See `CHANGELOG.md` and `docs/implementation/production-checklist.md`. No license has been chosen yet and the package is marked `private`; both must be decided by the owner before publishing to npm (which the plugin's MCP configuration depends on).
