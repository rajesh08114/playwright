# Security review status

Implemented controls include explicit allowed origins, metadata-address rejection, same-origin browser routing, redirect checks, read-only default test cases, no automatic form submission, local SQLite persistence, optional storage-state authentication, disabled LLM by default, and a pinned MCP SDK with zero production dependency vulnerabilities at the time of the last audit.

Before external deployment, review filesystem permissions for `.testswarm`, storage-state files, screenshots, traces, and MCP process credentials. Do not share those artifacts or authentication files with untrusted agents. Host-specific adapter invocation and remote MCP transport remain outside the verified surface.

Console and failed-network evidence is redacted before persistence and written with owner-only mode where supported by the host filesystem.
