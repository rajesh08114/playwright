import { z } from "zod";

export const Category = z.enum(["functional", "ui", "ux", "responsive", "accessibility", "security", "performance"]);
export const Priority = z.enum(["critical", "high", "medium", "low"]);
export const RunStatus = z.enum(["queued", "running", "completed", "failed", "cancelled"]);
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
  viewportProfiles: z.array(z.object({ name: z.string().min(1), width: z.number().int().positive(), height: z.number().int().positive() })).max(8).default([])
});

export const ProjectConfiguration = z.object({
  schemaVersion: z.literal(1), name: z.string().min(1), artifactsDir: z.string().default(".testswarm"), target: ApplicationTarget,
  benchmarkOraclePath: z.string().optional(),
  testData: z.object({ setupUrl: z.string().url(), cleanupUrl: z.string().url().optional(), fixturePath: z.string().optional(), timeoutMs: z.number().int().positive().max(30_000).default(10_000) }).optional(),
  budgets: z.object({ maxRoutes: z.number().int().positive().max(1000).default(25), maxCases: z.number().int().positive().max(1000).default(100), maxRetries: z.number().int().nonnegative().max(3).default(1), maxConcurrency: z.number().int().positive().max(8).default(1) }).default({ maxRoutes: 25, maxCases: 100, maxRetries: 1, maxConcurrency: 1 }),
  policy: z.object({ allowDestructiveActions: z.boolean().default(false), allowExternalNetwork: z.boolean().default(false), redactSecrets: z.boolean().default(true) }).default({ allowDestructiveActions: false, allowExternalNetwork: false, redactSecrets: true })
});
export type ApplicationTarget = z.infer<typeof ApplicationTarget>;

export const TestCase = z.object({
  id: z.string().min(1), title: z.string().min(1), feature: z.string().min(1), category: Category,
  priority: Priority, preconditions: z.array(z.string()), steps: z.array(z.string()).min(1),
  assertions: z.array(z.string()).min(1), expectedOutcome: z.string().min(1), requiredEvidence: z.array(z.string()),
  timeoutMs: z.number().int().positive(), destructive: z.enum(["none", "reversible", "destructive"])
});

export const TestPlan = z.object({ schemaVersion: z.literal(1), id: z.string(), generatedAt: z.string(), cases: z.array(TestCase) });
export const EvidenceArtifact = z.object({ id: z.string(), kind: z.enum(["screenshot", "trace", "console", "network", "accessibility", "json"]), path: z.string(), description: z.string() });
export const TestExecution = z.object({ id: z.string(), testCaseId: z.string(), viewportProfile: z.string().optional(), outcome: Outcome, startedAt: z.string(), finishedAt: z.string(), error: z.string().optional(), evidence: z.array(EvidenceArtifact) });
export const TestRun = z.object({ id: z.string(), projectName: z.string(), planId: z.string(), status: RunStatus, startedAt: z.string(), finishedAt: z.string().optional(), executions: z.array(TestExecution) });
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
export const RunReport = z.object({ schemaVersion: z.literal(1), runId: z.string(), generatedAt: z.string(), summary: z.object({ total: z.number(), passed: z.number(), failed: z.number(), blocked: z.number() }), executions: z.array(TestExecution), findings: z.array(DefectFinding) });

export type ProjectConfiguration = z.infer<typeof ProjectConfiguration>;
export type TestCase = z.infer<typeof TestCase>;
export type TestPlan = z.infer<typeof TestPlan>;
export type TestRun = z.infer<typeof TestRun>;
export type TestExecution = z.infer<typeof TestExecution>;
export type EvidenceArtifact = z.infer<typeof EvidenceArtifact>;
export type DiscoveryResult = z.infer<typeof DiscoveryResult>;
export type DefectFinding = z.infer<typeof DefectFinding>;
export type RunReport = z.infer<typeof RunReport>;
