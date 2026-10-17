import { z } from "zod";

export const Category = z.enum(["functional", "journey", "ui", "ux", "responsive", "accessibility", "security", "performance"]);

/** How a journey step finds an element. Exactly one strategy; no arbitrary script execution is possible. */
export const Locator = z.union([
  z.object({ role: z.string().min(1), name: z.string().optional(), exact: z.boolean().optional() }).strict(),
  z.object({ label: z.string().min(1), exact: z.boolean().optional() }).strict(),
  z.object({ text: z.string().min(1), exact: z.boolean().optional() }).strict(),
  z.object({ placeholder: z.string().min(1) }).strict(),
  z.object({ testId: z.string().min(1) }).strict(),
  z.object({ css: z.string().min(1) }).strict()
]);
export type Locator = z.infer<typeof Locator>;

/** One step of a user journey. Values for secrets come from environment variables and are never stored. */
export const Action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("goto"), path: z.string().startsWith("/") }).strict(),
  z.object({ type: z.literal("click"), target: Locator }).strict(),
  z.object({ type: z.literal("fill"), target: Locator, value: z.string().max(10_000).optional(), valueFromEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional() }).strict(),
  z.object({ type: z.literal("select"), target: Locator, value: z.string() }).strict(),
  z.object({ type: z.literal("check"), target: Locator, checked: z.boolean().default(true) }).strict(),
  z.object({ type: z.literal("press"), key: z.string().min(1).max(40), target: Locator.optional() }).strict(),
  z.object({ type: z.literal("waitFor"), target: Locator, state: z.enum(["visible", "hidden", "attached", "detached"]).default("visible") }).strict(),
  z.object({ type: z.literal("expectVisible"), target: Locator }).strict(),
  z.object({ type: z.literal("expectHidden"), target: Locator }).strict(),
  z.object({ type: z.literal("expectText"), target: Locator, text: z.string() }).strict(),
  z.object({ type: z.literal("expectUrl"), path: z.string().min(1) }).strict(),
  z.object({ type: z.literal("expectTitle"), text: z.string() }).strict()
]).superRefine((step, ctx) => {
  if (step.type === "fill" && (step.value === undefined) === (step.valueFromEnv === undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "fill needs exactly one of value or valueFromEnv" });
});
export type Action = z.infer<typeof Action>;

export const Journey = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/, "id must be 1-80 letters, digits, - or _"),
  title: z.string().min(1),
  startPath: z.string().startsWith("/").default("/"),
  priority: z.enum(["critical", "high", "medium", "low"]).default("medium"),
  destructive: z.enum(["none", "reversible", "destructive"]).default("none"),
  steps: z.array(Action).min(1).max(100)
}).strict();
export type Journey = z.infer<typeof Journey>;
export const Priority = z.enum(["critical", "high", "medium", "low"]);
// "blocked": nothing failed, but some cases could not be decided without a person (missing baseline, policy, secret).
export const RunStatus = z.enum(["queued", "running", "completed", "failed", "blocked", "cancelled"]);
export const Outcome = z.enum(["passed", "failed", "flaky", "infrastructure_failure", "inconclusive", "blocked"]);

export const ApplicationTarget = z.object({
  baseUrl: z.string().url(),
  allowedOrigins: z.array(z.string().url()).min(1),
  startPath: z.string().startsWith("/"),
  executablePath: z.string().min(1).optional(),
  visualBaselinesDir: z.string().optional(),
  viewportProfileName: z.string().optional(),
  storageStatePath: z.string().min(1).optional(),
  browser: z.enum(["chromium", "firefox", "webkit"]).default("chromium"),
  actionTimeoutMs: z.number().int().positive().max(120_000).default(10_000),
  navigationTimeoutMs: z.number().int().positive().max(120_000).default(30_000),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).default({ width: 1280, height: 720 }),
  viewportProfiles: z.array(z.object({ name: z.string().min(1), width: z.number().int().positive(), height: z.number().int().positive() })).max(8).default([]),
  routes: z.array(z.string().startsWith("/")).max(1000).default([]),
  /** Set false (or TESTSWARM_HEADED=1) to watch the browser while it works. */
  headless: z.boolean().default(true),
  /** Delay between browser operations, useful together with headless: false. */
  slowMoMs: z.number().int().nonnegative().max(5000).default(0)
});

/** Scripted login. Credentials come only from environment variables referenced by fill steps (valueFromEnv). */
export const AuthConfig = z.object({
  loginPath: z.string().startsWith("/"),
  steps: z.array(Action).min(1).max(30),
  /** Path (or substring of the URL) expected after a successful login. */
  successPath: z.string().min(1).optional(),
  /** Where the session is saved; default <artifactsDir>/auth/storage-state.json. */
  storageStatePath: z.string().optional(),
  maxAgeMinutes: z.number().int().positive().max(7 * 24 * 60).default(60)
}).strict();
export type AuthConfig = z.infer<typeof AuthConfig>;

/** Model-assisted journey planning. Off unless enabled; page snapshots are sent to the provider. */
export const LlmConfig = z.object({
  enabled: z.boolean().default(false),
  provider: z.literal("anthropic").default("anthropic"),
  model: z.string().min(1).default("claude-opus-5-5"),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  maxJourneysPerRoute: z.number().int().positive().max(10).default(3),
  maxRoutes: z.number().int().positive().max(50).default(10),
  maxSnapshotChars: z.number().int().positive().max(200_000).default(20_000),
  /** Limits for the deep-agent explorer (plan-agent). */
  agent: z.object({
    /** Journey executions the agent may make across the whole run. */
    maxTrials: z.number().int().positive().max(500).default(40),
    /** LangGraph recursion limit for the coordinator (each model or tool step counts). */
    recursionLimit: z.number().int().positive().max(2000).default(250),
    timeoutMinutes: z.number().positive().max(240).default(20)
  }).strict().default({})
}).strict();
export type LlmConfig = z.infer<typeof LlmConfig>;

export const Impact = z.enum(["minor", "moderate", "serious", "critical"]);
export type Impact = z.infer<typeof Impact>;
export const Policy = z.object({
  allowDestructiveActions: z.boolean().default(false),
  allowExternalNetwork: z.boolean().default(false),
  redactSecrets: z.boolean().default(true),
  accessibilityFailOn: Impact.default("serious"),
  failOnConsoleErrors: z.boolean().default(true),
  visualMaxDiffRatio: z.number().min(0).max(1).default(0.001),
  maskSelectors: z.array(z.string().min(1)).max(50).default([]),
  trace: z.enum(["off", "on", "retain-on-failure"]).default("retain-on-failure"),
  retainRuns: z.number().int().positive().max(10_000).default(50)
});
export type Policy = z.infer<typeof Policy>;

export const ProjectConfiguration = z.object({
  schemaVersion: z.literal(1), name: z.string().min(1), artifactsDir: z.string().default(".testswarm"), target: ApplicationTarget,
  benchmarkOraclePath: z.string().optional(),
  journeys: z.array(Journey).max(500).default([]),
  auth: AuthConfig.optional(),
  llm: LlmConfig.optional(),
  testData: z.object({ setupUrl: z.string().url(), cleanupUrl: z.string().url().optional(), fixturePath: z.string().optional(), timeoutMs: z.number().int().positive().max(30_000).default(10_000) }).optional(),
  budgets: z.object({ maxRoutes: z.number().int().positive().max(1000).default(25), maxCases: z.number().int().positive().max(1000).default(100), maxRetries: z.number().int().nonnegative().max(3).default(1), maxConcurrency: z.number().int().positive().max(8).default(1) }).default({ maxRoutes: 25, maxCases: 100, maxRetries: 1, maxConcurrency: 1 }),
  policy: Policy.default({})
});
export type ApplicationTarget = z.infer<typeof ApplicationTarget>;

export const TestCase = z.object({
  id: z.string().min(1), title: z.string().min(1), feature: z.string().min(1), category: Category,
  priority: Priority, preconditions: z.array(z.string()), steps: z.array(z.string()).min(1),
  assertions: z.array(z.string()).min(1), expectedOutcome: z.string().min(1), requiredEvidence: z.array(z.string()),
  timeoutMs: z.number().int().positive(), destructive: z.enum(["none", "reversible", "destructive"]),
  /** Structured steps for journey cases; the runner executes these instead of the default page checks. */
  actions: z.array(Action).optional(),
  /** Where the case came from: generated by the planner rules, written by the user, or proposed by a model. */
  origin: z.enum(["deterministic", "configured", "generated"]).optional()
});

export const TestPlan = z.object({ schemaVersion: z.literal(1), id: z.string(), generatedAt: z.string(), cases: z.array(TestCase) });
export const EvidenceArtifact = z.object({ id: z.string(), kind: z.enum(["screenshot", "trace", "console", "network", "accessibility", "json"]), path: z.string(), description: z.string() });
export const TestExecution = z.object({ id: z.string(), testCaseId: z.string(), viewportProfile: z.string().optional(), outcome: Outcome, startedAt: z.string(), finishedAt: z.string(), error: z.string().optional(), evidence: z.array(EvidenceArtifact) });
export const TestRun = z.object({ id: z.string(), projectName: z.string(), planId: z.string(), status: RunStatus, startedAt: z.string(), finishedAt: z.string().optional(), expectedExecutions: z.number().int().nonnegative().optional(), retestOf: z.string().optional(), error: z.string().optional(), executions: z.array(TestExecution) });
export const Requirement = z.object({ id: z.string(), text: z.string().min(1), source: z.enum(["user", "repository", "observed", "generated"]), confidence: z.number().min(0).max(1) });
export const ComponentObservation = z.object({ id: z.string(), route: z.string(), selector: z.string(), role: z.string().optional(), label: z.string().optional(), source: z.enum(["browser", "repository", "api"]), confidence: z.number().min(0).max(1) });
export const WorkflowTransition = z.object({ from: z.string(), action: z.string(), to: z.string(), confidence: z.number().min(0).max(1) });
export const AgentTask = z.object({ id: z.string(), runId: z.string(), agent: z.string(), status: z.enum(["queued", "running", "completed", "failed", "cancelled"]), budgetMs: z.number().int().positive(), input: z.record(z.unknown()) });
export const AgentResult = z.object({ taskId: z.string(), status: z.enum(["completed", "failed", "cancelled"]), observations: z.array(z.string()), evidence: z.array(EvidenceArtifact), error: z.string().optional() });
export type AgentTask = z.infer<typeof AgentTask>;
export type AgentResult = z.infer<typeof AgentResult>;
export const CoverageRecord = z.object({ feature: z.string(), testCaseIds: z.array(z.string()), executions: z.number().int().nonnegative(), covered: z.boolean() });
export const ApprovalRequest = z.object({ id: z.string(), action: z.enum(["destructive_test", "source_change", "external_llm"]), reason: z.string(), status: z.enum(["pending", "approved", "denied"]), createdAt: z.string() });
export const TestDataFixture = z.object({ id: z.string(), description: z.string(), data: z.record(z.unknown()), cleanupRequired: z.boolean().default(false) });
export type TestDataFixture = z.infer<typeof TestDataFixture>;
export const SeededDefect = z.object({ id: z.string(), route: z.string(), description: z.string(), expectedCategories: z.array(Category) });
export type SeededDefect = z.infer<typeof SeededDefect>;
export const DiscoveredRoute = z.object({ path: z.string(), title: z.string().optional(), heading: z.string().optional(), source: z.enum(["browser-observed", "configured"]), confidence: z.number().min(0).max(1), links: z.array(z.string()), forms: z.number().int().nonnegative(), interactiveElements: z.number().int().nonnegative() });
export const ApplicationFeature = z.object({ id: z.string(), name: z.string(), routePaths: z.array(z.string()), confidence: z.number().min(0).max(1), observations: z.array(z.string()) });
export const DiscoveryResult = z.object({ schemaVersion: z.literal(1), startedAt: z.string(), finishedAt: z.string(), routes: z.array(DiscoveredRoute), features: z.array(ApplicationFeature), warnings: z.array(z.string()) });
export type DiscoveredRoute = z.infer<typeof DiscoveredRoute>;
export const DefectFinding = z.object({ findingId: z.string(), runId: z.string(), affectedFeature: z.string(), route: z.string(), category: Category, severity: z.enum(["low", "medium", "high", "critical"]), confidence: z.number().min(0).max(1), reproduction: z.array(z.string()), verificationState: z.enum(["confirmed", "probable", "unverified", "infrastructure_failure", "inconclusive"]), evidenceReferences: z.array(z.string()), remediation: z.string() });
export const RunReport = z.object({ schemaVersion: z.literal(1), runId: z.string(), generatedAt: z.string(), summary: z.object({ total: z.number(), passed: z.number(), failed: z.number(), flaky: z.number(), blocked: z.number(), infrastructure: z.number() }), executions: z.array(TestExecution), findings: z.array(DefectFinding) });

export type ProjectConfiguration = z.infer<typeof ProjectConfiguration>;
export type TestCase = z.infer<typeof TestCase>;
export type TestPlan = z.infer<typeof TestPlan>;
export type TestRun = z.infer<typeof TestRun>;
export type TestExecution = z.infer<typeof TestExecution>;
export type EvidenceArtifact = z.infer<typeof EvidenceArtifact>;
export type DiscoveryResult = z.infer<typeof DiscoveryResult>;
export type DefectFinding = z.infer<typeof DefectFinding>;
export type RunReport = z.infer<typeof RunReport>;
