# Deep-agent exploratory planning (`plan-agent`)

## Problem

`plan-ai` makes one model call: Claude sees page snapshots and guesses journeys. Guesses are never checked against the
running app, so many fail on the first run for trivial reasons (wrong accessible name, a step that needs a wait, a
different URL after submit). The user then has to debug model output by hand.

## Approach

Use a LangGraph [Deep Agent](https://docs.langchain.com/oss/javascript/deepagents/overview) (`deepagents`) as an
exploratory tester that *verifies its own work* against the real application:

```
plan-agent
  discover routes (existing crawler, login applied)
  coordinator deep agent
    write_todos: one item per route (or group)
    task -> route-explorer subagent (isolated context, one route at a time)
      snapshot_page   accessibility tree of the route (redacted, truncated)
      try_journey     run a candidate in a fresh browser context; on failure get the
                      failing step, the error, and a snapshot of the page at that moment
      (fix and retry, bounded)
      submit_journey  record the journey; marked verified only if this exact journey passed
      report_finding  the app behaved contrary to its visible intent (candidate defect)
  plan = route checks + configured journeys + verified generated journeys
  review file = every submission (verified or not), findings, trials, token usage
```

Why this improves outcomes:

- **Self-correction against ground truth.** A journey enters the plan only after it passed in the browser, so the
  plan's journeys are runnable by construction. Measured by the share of submissions that are verified.
- **Isolated context per route.** Subagents keep each route's snapshots and retries out of the coordinator's context,
  so larger apps don't degrade the planning.
- **Explicit planning.** `write_todos` keeps coverage systematic instead of whatever one response happens to include.
- **Findings, not just tests.** When a journey fails because the app is wrong (button does nothing, error page), the
  agent reports a candidate defect with reproduction steps.

## Safety model

Deep Agents "trusts the LLM": boundaries must be enforced by tools. Ours:

| Boundary | Enforcement |
| --- | --- |
| What the agent can do in the browser | Only `try_journey`, which accepts the same closed `Action` schema the runner uses (no scripts) and validates it |
| Where it can go | Every browser context routes requests through `target.allowedOrigins`; `goto` outside them fails |
| State changes | A journey that types, selects, presses keys, or clicks anything but a link is classified `reversible` and is **not executed** unless `policy.allowDestructiveActions` is on; it can still be submitted, unverified, for human review |
| Secrets | `valueFromEnv` is not available to the agent; credentials are only used by the configured login |
| Cost and runtime | `llm.agent.maxTrials`, `recursionLimit`, `timeoutMinutes`; token usage recorded |
| Agent files | Deep Agents' default in-memory `StateBackend`; no `FilesystemBackend`/`LocalShellBackend`, so the agent cannot touch the disk or run shell commands |
| Untrusted page text | Framed as data in both prompts; the agent's only outputs are schema-validated tool calls |

## Dependencies

`deepagents`, `@langchain/anthropic`, `@langchain/core`, and `@langchain/langgraph` are **optional dependencies**,
imported dynamically only by `plan-agent`. The rest of TestSwarm does not load them.

`deepagents` depends on `fast-glob`/`micromatch` → `braces`, which has an unpatched high-severity advisory
(GHSA-vfj7-8cjw-p6xm, stack exhaustion on deeply nested glob patterns). Those libraries are only called by
`FilesystemBackend` and `LocalShellBackend`. TestSwarm never constructs either (enforced by a test), so the vulnerable
code is unreachable. `scripts/audit.mjs` fails CI on any high or critical advisory except that one, documented
allowlist entry; remove it when a fixed `braces` ships.

## Configuration

```json
"llm": {
  "enabled": true,
  "model": "claude-opus-5-5",
  "agent": { "maxTrials": 40, "recursionLimit": 250, "timeoutMinutes": 20 }
}
```

## Interfaces

- CLI: `testswarm plan-agent`
- MCP: `testswarm_plan_with_agent`
- Engine: `planWithAgent()`; tests inject a scripted chat model (`EngineOptions.agentModel`).

## Not in scope

- Running state-changing exploration automatically. Enabling `policy.allowDestructiveActions` lets the agent execute
  such journeys; do that only against disposable test environments.
- Long-term agent memory across runs (Deep Agents `store`); each run starts fresh.
