# Security review status

## Controls

- **Network scope.** Every browser request is checked against `target.allowedOrigins`; others are aborted and recorded as policy-blocked. Top-level navigation and redirects outside the allowed origins fail the case even when `policy.allowExternalNetwork` is on. Cloud metadata endpoints and unspecified addresses are rejected at config load. Test-data endpoints must be allowed origins.
- **No state changes by default.** Discovery never submits forms and skips links that look state-changing (logout, delete, remove, unsubscribe). Cases marked `reversible`/`destructive` are blocked unless `policy.allowDestructiveActions` is set.
- **No arbitrary execution.** Neither the CLI nor the MCP server runs shell commands or user-supplied scripts. The MCP surface has no file-read or file-delete tools; `prune` is CLI-only.
- **Human-in-the-loop for baselines.** Approving visual baselines is a separate, explicit action, marked destructive in MCP tool annotations; the plugin skill instructs the agent never to self-approve.
- **Evidence handling.** Console and network evidence is redacted (bearer tokens, cookies, key/secret/password fields, URL query secrets, JWTs, common API-key formats) and written `0600`. The database is `0600` in a `0700` directory where the filesystem supports it.
- **Model calls.** Only `plan-ai`, only when `llm.enabled` is true. It sends redacted, truncated accessibility snapshots (not HTML, cookies, or storage) to Anthropic. Page text is framed as untrusted data; the model can only return a fixed schema of declarative actions, each re-validated; proposals that change state are blocked until a human reviews them.
- **Deep agent (`plan-agent`).** Opt-in like `plan-ai`. The agent's only effects are TestSwarm tools: page snapshots, journey trials in fresh origin-restricted browser contexts (closed action schema, no secrets, interactive journeys refused unless `policy.allowDestructiveActions`), and records. Agent files use the in-memory backend; disk and shell backends are never constructed (tested). Trials, recursion depth, and wall time are capped.
- **Known advisory.** `braces` (GHSA-vfj7-8cjw-p6xm, via deepagents' optional glob dependencies) has no fix; it is reachable only through backends TestSwarm never uses. `scripts/audit.mjs` allowlists exactly this advisory and fails when the entry becomes stale.
- **Secrets in journeys and login.** Supplied only through environment variables (`valueFromEnv`), never written to plans, reports, or step descriptions; cases and logins that type secrets are not traced. Saved sessions are written `0600`.
- **Dependencies.** MCP SDK pinned; `npm audit --omit=dev` runs in CI.

## Residual risks

- Screenshots, traces, and axe results are not redacted; they contain whatever the page displays. Use `policy.maskSelectors` for sensitive regions and treat `.testswarm/` as sensitive.
- Storage-state files (including the one `auth` saves) are credentials. Keep them out of version control and outside shared artifact uploads.
- Redaction is pattern-based and cannot catch every secret format.
- Host-specific adapter invocation and remote MCP transports have not been independently reviewed; deployments should do their own permission review and penetration testing.
