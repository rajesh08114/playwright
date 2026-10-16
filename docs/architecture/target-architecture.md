# Target architecture

`core` owns validated contracts, configuration, lifecycle, and persistence. Planner, discovery, browser runtime, agents, verification, evidence, and reporting remain independently testable services. CLI and MCP are thin transports over the same engine. Host integrations contain only packaging and invocation metadata.

SQLite is the default local store using Node's built-in SQLite API, with WAL mode, foreign keys, and indexed run status. `JsonStore` remains available only as a compatibility/test adapter. Production deployments should use Node 22.5 or newer.

Specialized agents are thin deterministic executors over the shared browser runtime: functional, UI/responsive, accessibility, and verification. The orchestrator owns scopes, budgets, evidence, and task results; agents do not own persistence or transport logic.
