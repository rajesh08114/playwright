# TestSwarm AI

TestSwarm AI is a local-first, multi-agent browser testing engine built on Playwright. It discovers routes, plans coverage, executes browser checks, stores run history in SQLite, captures evidence, reports defects, and exposes the workflow through both a CLI and MCP server.

The project is currently a production-oriented foundation and reference implementation. It is designed to run safely against an explicitly configured target; it does not claim to replace application-specific test design, security testing, or human release approval.

## Requirements

- Node.js 22.5 or newer. The default store uses Node's built-in `node:sqlite` module.
- npm.
- Chromium. Playwright can install a managed browser, or a local browser executable can be configured.

Check the installed versions:

```powershell
node --version
npm --version
```

## Quick start

From the repository root:

```powershell
npm.cmd install
npm.cmd run build
npm.cmd test
npm.cmd run demo
```

On Windows PowerShell, use `npm.cmd` if the local execution policy blocks `npm.ps1`.

To install a Playwright-managed Chromium browser:

```powershell
npx.cmd playwright install chromium
```

The demo uses the included app in `fixtures/demo-app`. It starts a local target, discovers pages, creates a plan, executes it, and writes evidence under `.testswarm/`.

## Run against a configured target

Copy the example configuration and edit the target URL, routes, browser settings, and allowed origins:

```powershell
Copy-Item testswarm.config.example.json testswarm.config.json
npm.cmd run build
node dist/src/cli/index.js init
node dist/src/cli/index.js inspect
node dist/src/cli/index.js doctor
node dist/src/cli/index.js discover
node dist/src/cli/index.js plan-discovered
node dist/src/cli/index.js run <plan-id>
node dist/src/cli/index.js report <run-id>
```

`testswarm.config.json` is intentionally ignored because it commonly contains a machine-specific browser path or target URL. Keep reusable, non-machine-specific defaults in `testswarm.config.example.json`.

Useful configuration concepts include:

- `target.baseUrl`: the application origin to test.
- `target.allowedOrigins`: origins that navigation and test-data requests may access.
- `target.routes`: known routes to include in discovery and planning.
- `target.executablePath`: optional local browser executable; omit it to use Playwright's managed browser.
- `profiles`: viewport/device profiles to exercise.
- `policies`: retries, timeouts, evidence retention, and destructive-action controls.

## CLI commands

The CLI is available after `npm.cmd run build`:

```text
node dist/src/cli/index.js <command> [options]
```

Common commands:

| Command | Purpose |
| --- | --- |
| `init` | Initialize the local SQLite store. |
| `inspect` | Show the loaded configuration and target summary. |
| `doctor` | Check configuration, browser availability, storage, and safety settings. |
| `discover` | Discover routes and page capabilities. |
| `plan` | Create a plan from explicit routes or scenarios. |
| `plan-discovered` | Create a plan from the latest discovery. |
| `run <plan-id>` | Execute a plan. |
| `status <run-id>` | Show current run status. |
| `runs` | List recent runs. |
| `results <run-id>` | Show test results. |
| `evidence <run-id>` | List captured evidence. |
| `verify <run-id>` | Verify deterministic seeded defects or run assertions. |
| `retest <run-id>` | Re-run failed or selected cases. |
| `resume <run-id>` | Resume an interrupted run when possible. |
| `repeat <run-id>` | Repeat a run for stability analysis. |
| `report <run-id>` | Produce a human-readable report. |
| `export <run-id>` | Export run data and evidence metadata. |
| `agents` / `agent-run` | Inspect and execute the multi-agent workflow. |
| `benchmark` / `compare` / `baseline` | Measure and compare run performance. |
| `cancel <run-id>` | Request cancellation of an active run. |

Run `node dist/src/cli/index.js --help` for the complete option list.

## MCP server

Build the project and start the stdio MCP server:

```powershell
npm.cmd run mcp
```

Project-scoped client configurations are included for Claude Code and Cursor:

- `.mcp.json`
- `.cursor/mcp.json`

The server exposes safe tools for planning, discovery, execution, status, reporting, evidence, verification, retesting, recovery, benchmarking, and health checks. Keep the server pointed at an explicitly configured target and review generated evidence before using it in a release decision.

## Generated data and security

Runtime output is written below `.testswarm/`, including the SQLite database, run records, reports, screenshots, accessibility results, visual baselines, and benchmark data. These files are local artifacts and are ignored by Git.

The default safety model includes:

- explicit allowed-origin checks for browser navigation and HTTP test-data requests;
- no arbitrary shell execution through the CLI or MCP surface;
- isolated browser contexts and optional storage-state handling;
- redaction of common secrets from captured evidence;
- controlled retries, timeouts, cancellation, and recovery records;
- destructive-action and external-network policy gates.

Do not commit real credentials, storage state, target data, screenshots containing sensitive information, local browser paths, or generated databases. Use environment variables or a secret manager for credentials in deployment environments.

## Repository layout

```text
src/core/              contracts, configuration, engine, SQLite store
src/browser-runtime/   Playwright execution and evidence capture
src/discovery/         route and capability discovery
src/planner/           coverage planning
src/agents/            multi-agent orchestration
src/benchmarks/        performance and comparison workflows
src/mcp-server/        MCP tool server
src/cli/               command-line interface
tests/                 unit, adapter, recovery, and runtime tests
fixtures/demo-app/     local demo target and seeded defects
docs/                  architecture, security, roadmap, and checklists
integrations/          client-specific setup notes
```

## Development

Run the checks used by CI or before a commit:

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run lint
npm.cmd audit --omit=dev
```

The current automated suite covers contracts, configuration, planning, storage, discovery, runtime behavior, recovery, redaction, test data, agents, benchmarking, and health checks. Review `docs/implementation/production-checklist.md` for the remaining environment-specific release validation items.

## License

No license has been selected for this repository yet. Add a license file before distributing the project outside the intended development team.
