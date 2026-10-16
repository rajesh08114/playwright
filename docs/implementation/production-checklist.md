# Production checklist

## Implemented and verified

- [x] Versioned Zod contracts for configuration, plans, runs, discovery, findings, reports, agent tasks, coverage, and approvals
- [x] SQLite local persistence with WAL mode and foreign keys
- [x] JSON compatibility store for migration/tests
- [x] Run status persistence, listing, and cancellation
- [x] Origin-restricted browser requests and redirect checks
- [x] Same-origin bounded discovery without automatic form submission
- [x] Discovery-derived functional/accessibility plan generation
- [x] Playwright screenshots, console errors, and failed-request evidence
- [x] CLI and MCP shared engine
- [x] Reports in JSON and HTML
- [x] JUnit XML report output
- [x] Bounded retry budget with flaky classification after recovery
- [x] axe-core accessibility evidence collection
- [x] Configured responsive viewport profiles with deterministic overflow checks
- [x] Live demo discovery, planning, execution, and artifact generation
- [x] Live MCP JSON-RPC initialization and tool-list verification
- [x] MCP SDK pinned to patched 1.31.0 release with clean install audit result
- [x] Plan export as reusable Playwright source
- [x] Provider-neutral LLM interface with disabled safe default
- [x] Unit tests and TypeScript build/lint checks

## Remaining verification gates

- [ ] Visual baselines
- [ ] Authentication/test-data fixtures
- [ ] Retry/flakiness measurement and crash recovery tests
- [ ] Benchmark comparison and seeded-defect recall measurement
- [ ] Host-specific Claude Code, Cursor, and Antigravity invocation validation
- [ ] Security review of deployment permissions and artifact handling
