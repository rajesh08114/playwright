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
- [x] Production dependency audit reports zero vulnerabilities
- [x] Measured benchmark output for coverage, outcomes, evidence, and viewport profiles
- [x] Optional seeded-defect oracle with measured recall (when configured)
- [x] Controlled seeded-defect demo configuration and benchmark fixture
- [x] Browser/infrastructure failure classification
- [x] Seeded demo run with measured defect recall
- [x] Explicit visual baseline approval and deterministic screenshot comparison
- [x] Missing UI baselines classified as blocked instead of passed
- [x] Security review status and deployment handling guidance documented
- [x] Evidence secret redaction for console and network artifacts
- [x] Controlled Playwright storage-state authentication support
- [x] Persisted run resume for interrupted/failed runs
- [x] Explicit test-data provider interface with safe no-op default
- [x] Bounded repeated-plan execution with measured stability summary
- [x] Persisted-run benchmark comparison with outcome deltas
- [x] Persisted specialist-agent runs comparable with sequential deterministic runs
- [x] Browser-disconnect infrastructure failure test
- [x] Plan export as reusable Playwright source
- [x] Provider-neutral LLM interface with disabled safe default
- [x] Scoped functional, UI/responsive, accessibility, and verification agent contracts
- [x] Bounded specialist-agent orchestrator over the shared runtime
- [x] Project-scoped Claude Code MCP configuration generated and inspected
- [x] Workspace Cursor MCP configuration provided
- [x] Unit tests and TypeScript build/lint checks

## Remaining verification gates

- [x] Explicit HTTP test-data setup/cleanup adapter with bounded requests
- [x] Test-data setup failures finalize runs instead of leaving orphaned running state
- [x] CLI/MCP production preflight doctor checks
- [ ] Recovery after an externally terminated browser process
- [ ] External single-agent model-cost/quality baseline comparison
- [ ] Interactive Claude Code and Cursor agent invocation validation
- [ ] Antigravity invocation validation (host not installed)
- [ ] Deployment-specific permission review and external penetration testing
