# Changelog

## Unreleased

### Added
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
