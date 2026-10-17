# Production checklist

## Verified by automated tests

- [x] Config validation, origin policy (metadata/unspecified hosts rejected), project-relative paths
- [x] SQLite store: migrations (v1 -> v2), execution rows, durable cancellation, pruning, recovery after restart
- [x] Functional checks: HTTP status, heading, console errors, same-origin request failures
- [x] Accessibility checks fail at the configured axe impact threshold
- [x] Responsive overflow detection
- [x] Visual baselines: blocked when missing, pixel-diff pass/fail with diff evidence
- [x] Destructive cases blocked by default; third-party requests blocked and recorded
- [x] Infrastructure classification for launch failure and browser disconnect
- [x] Traces retained on failure only (default)
- [x] End-to-end: discovery -> plan -> run -> baseline approval -> green run on the demo app
- [x] Seeded defects (functional, accessibility, responsive) detected with recall 1.0
- [x] Retest re-runs only non-passing cases; cross-process cancel; resume after cancel
- [x] MCP protocol: tool listing, annotations, calls, structured errors
- [x] Report escaping (HTML/XML), finding grouping, redaction patterns
- [x] Plugin manifest, marketplace, and MCP config consistent with package version
- [x] Journeys: pass, step-numbered failure with trace, blocked on missing secret, exported as Playwright code
- [x] Scripted login: session saved owner-only and reused by journeys; wrong password fails with the failing step
- [x] Model-assisted planning: snapshot capture, proposal validation and rejection, state-changing proposals blocked, refusal/truncation/auth errors surfaced (request shape verified against the SDK with a stubbed transport)
- [x] Stale running runs detected and resumable without `--force`

## Owner decisions before first public release

- [ ] Choose a license and add `LICENSE`
- [ ] Remove `"private": true` and publish `testswarm-ai` to npm (the plugin's MCP config runs `npx -p testswarm-ai@<version> testswarm-mcp`)
- [ ] Confirm the CI workflow runs green on GitHub Actions (Ubuntu Node 22/24, Windows Node 22)

## Not yet implemented

- [ ] A live `plan-ai` call against the Anthropic API (verified only with a stubbed transport; needs an API key)
- [ ] Quality evaluation of model-proposed journeys on real applications
- [ ] Login flows that need MFA or CAPTCHA (use a pre-recorded `target.storageStatePath` for those)
- [ ] Interactive validation inside Claude Code, Cursor, and Antigravity hosts
- [ ] External penetration testing and deployment-specific permission review
