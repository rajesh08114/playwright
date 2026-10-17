---
name: browser-testing
description: Test a web application in a real browser with TestSwarm. Use when the user asks to test, smoke-test, QA, check accessibility, check responsiveness, or catch visual regressions in the web app they are working on, or to verify a UI change works before they ship it.
---

# Browser testing with TestSwarm

TestSwarm runs deterministic Playwright checks against the target configured in the project's `testswarm.config.json`. Its MCP tools are prefixed `testswarm_`.

## Workflow

1. **Preflight.** Call `testswarm_doctor`. If the configuration is missing, ask the user for the URL of the running app and call `testswarm_init` with it as `baseUrl`. If the browser check fails, tell the user to run `npx playwright install chromium`. If the target is unreachable, ask the user to start their dev server; do not start servers yourself without asking.
2. **Plan.** Call `testswarm_plan_from_discovery` to crawl same-origin routes, or `testswarm_plan` to use only `target.startPath` and `target.routes`. Summarise the routes and case counts for the user.
3. **Run.** Call `testswarm_run` with the plan id. It returns a `runId` immediately. Poll `testswarm_status` (a few seconds apart) until `status` is no longer `running`.
4. **Review.** Call `testswarm_verify` for grouped findings and `testswarm_report` for the HTML report path. Report failures with their route, category, viewport, and the observed error, and point to the screenshot or trace in `testswarm_evidence`.
5. **Fix and retest.** After a fix, call `testswarm_retest` with the previous run id; it re-runs only what did not pass.

## Rules

- Findings are observations, not confirmed bugs. Say "probable" or "unverified" as the finding states.
- UI (visual) cases are `blocked` until baselines exist. Only call `testswarm_baseline` after the user has looked at the screenshots and agreed they are correct. Never approve baselines on your own to make a run green.
- Do not change `policy.allowDestructiveActions` or `policy.allowExternalNetwork` unless the user asks.
- `testswarm_cancel` stops a run; use it if the user asks to stop or a run is clearly misconfigured.
