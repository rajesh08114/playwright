# Changelog

## Unreleased

### Fixed (end-to-end reliability)
- **Browser start-up**: when the build Playwright expects is missing (the usual state right after an install or upgrade), TestSwarm now falls back to other downloaded Chromium builds, then installed Chrome, then Edge, and says which one it used. When nothing starts, the error lists every attempt and the fix. Playwright is pinned to an exact version so builds no longer drift. New `install-browser` command and `testswarm_install_browser` MCP tool.
- **MCP start-up**: `.mcp.json` now launches `scripts/mcp.mjs`, which builds the server when `dist/` is missing or stale (output to stderr) before starting it, so a fresh clone or `git pull` no longer leaves the client with a server that fails to connect.
- **MCP responses**: planning, results, report, and agent tools return compact summaries instead of whole objects (a 4-page plan went from ~10 KB to under 3 KB; reports from ~25 KB to a summary); `testswarm_get_plan`, `includePassed`, and evidence filters give details on request.
- **Run status**: a run with no failures but cases waiting on a person (missing baselines, policy, secrets) now ends `blocked` instead of `failed`, and `status`/CLI output include plain-language next steps.
- Headed mode on Linux without a display now fails with a clear message instead of "browser has been closed".

### Added
- `testswarm_screenshot` MCP tool: returns the page image (or visual diff/baseline) for a case so the assistant can see the UI it tested.
- Headed runs: `--headed`, `TESTSWARM_HEADED=1`, `target.headless`, and `target.slowMoMs`.
- End-to-end MCP test: a real MCP client drives the server through the launcher from an empty project to a green run, with no browser path configured.
- **Deep-agent exploration** (`plan-agent`, `testswarm_plan_with_agent`): a LangGraph Deep Agent plans coverage with `write_todos`, delegates each route to an isolated `route-explorer` subagent, runs candidate journeys in the real browser, self-corrects from the failing step and a fresh snapshot, and adds only journeys that passed. Read-only execution by default; trial, recursion, and time budgets; candidate defects and token usage recorded for review. LangChain packages are optional dependencies loaded only by this command.
- `npm run audit` (CI): fails on high/critical advisories except a documented, test-enforced allowlist (currently the unpatched `braces` advisory, unreachable from TestSwarm).
- **User journeys**: multi-step flows defined as structured actions (click, fill, select, press, expect text/URL/title, ...) with accessible locators. Failures name the step. Secrets come from environment variables, are never stored or traced, and a missing secret blocks the case.
- **Scripted login** (`auth`): signs in before discovery and runs, saves an owner-only session file, reuses it for `maxAgeMinutes`; `testswarm login` and a doctor check for the required variables. A failed login fails the run immediately.
- **Model-assisted planning** (`plan-ai`, `testswarm_plan_with_ai`): sends redacted accessibility snapshots to Claude and adds validated journey proposals to the plan. Off by default; proposals that change state stay blocked until reviewed; proposals are saved for review with token usage.
- **Stale-run detection**: runs heartbeat every 15 s; `status` flags a running run with no activity for 2 minutes as stale, and `resume` accepts it without `--force`.
- Demo app: working sign-in, protected account page, search, and a client-side cart.

### Changed
- `src/llm/provider.ts` now defines a journey-proposal interface; the previous unused generic completion interface was removed.

## 0.1.0 (merged in #1)

### Fixed (results that were wrong before)
- Accessibility cases now fail on axe violations at or above `policy.accessibilityFailOn`; previously violations were recorded but every case passed.
- UI cases are `blocked` when no baseline exists; previously they passed when `visualBaselinesDir` was unset.
- Visual comparison uses a pixel diff with a tolerance and writes a diff image, instead of an exact byte comparison.
- Functional cases check the HTTP status, console errors, and failed same-origin requests.
- `cancel` works across processes (durable flag in the database); previously it only affected the process that issued it and was then overwritten.
- `flaky` is treated as passing consistently in `run`, `resume`, and reports.
- HTML reports escape all text; JUnit XML is well-formed.
- Unused configuration (`maxRoutes`, `maxCases`, `maxConcurrency`, all `policy` flags) is now enforced.

### Added
- Parallel workers with one shared browser each, relaunched on crash.
- Playwright traces (`policy.trace`), screenshot masking (`policy.maskSelectors`).
- Discovery from `target.routes` and `sitemap.xml`; query strings kept; state-changing links skipped.
- Stable route-based case ids so baselines and comparisons survive rediscovery.
- `retest` runs only non-passing cases; `resume --force`; `prune`; `status` progress.
- CLI argument parsing, `--help`, `--version`, `--project`, `--config`, `--json`, human-readable output, exit codes.
- MCP: background runs with polling, structured tool errors, tool annotations, `testswarm_init`, `testswarm_list_runs`, graceful shutdown.
- Claude Code plugin and marketplace manifest; `testswarm-mcp` bin; CI workflow.
- SQLite schema migrations; executions stored as rows; v1 databases migrate automatically.
- Broader secret redaction (JWTs, GitHub/AWS/Stripe-style keys, URL query secrets, JSON fields).

### Changed
- Requires Node.js 22.13+ (`node:sqlite` without a flag).
- Case ids changed from `TS-DISC-001` style to `TS-FUNC-<route>`; existing baselines need re-approval.
- `Engine` takes an options object (`{ projectDir, configPath, store }`); `executeCase` takes an options object.
