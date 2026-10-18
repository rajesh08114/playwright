import { randomUUID } from "node:crypto";
import { TestPlan, TestCase, DiscoveryResult, Journey } from "../core/contracts.js";
import { describeAction } from "../browser-runtime/actions.js";

/** Stable, filesystem-safe identifier for a route, so case ids (and visual baselines) survive rediscovery. */
export function routeSlug(route: string) {
  const slug = route.replace(/^\/+|\/+$/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return (slug || "root").slice(0, 80);
}

export function createStarterPlan(feature = "homepage", startPath = "/"): TestPlan {
  return createPlanForRoutes([{ path: startPath, feature }], { categories: ["functional"] });
}

export interface PlanOptions {
  categories?: TestCase["category"][];
  maxCases?: number;
  /** Journey cases placed ahead of route checks (they are kept first when maxCases truncates). */
  journeys?: TestCase[];
}

/** Turns journeys into executable cases. Steps are human-readable; `actions` is what the runner executes. */
export function journeysToCases(journeys: Journey[], origin: NonNullable<TestCase["origin"]> = "configured"): TestCase[] {
  return journeys.map(journey => ({
    id: `TS-JRNY-${journey.id}`,
    title: journey.title,
    feature: journey.title,
    category: "journey",
    priority: journey.priority,
    preconditions: [],
    steps: [`Navigate to ${journey.startPath}`, ...journey.steps.map(describeAction)],
    assertions: journey.steps.filter(step => step.type.startsWith("expect")).map(describeAction).concat("Every step completes"),
    expectedOutcome: "The journey completes without errors",
    requiredEvidence: ["screenshot", "console", "network"],
    timeoutMs: 60000,
    destructive: journey.destructive,
    actions: journey.steps,
    origin
  }));
}

/** Builds the deterministic case set for each route. Steps and assertions describe exactly what the runner checks. */
export function createPlanForRoutes(routes: Array<{ path: string; feature: string }>, options: PlanOptions = {}): TestPlan {
  const categories = new Set(options.categories ?? ["functional", "accessibility", "responsive", "ui"]);
  const seen = new Set<string>();
  const cases: TestCase[] = routes.flatMap((route, index) => {
    let slug = routeSlug(route.path);
    while (seen.has(slug)) slug = `${slug}-${index}`;
    seen.add(slug);
    const common = { feature: route.feature, preconditions: [] as string[], timeoutMs: 30000, destructive: "none" as const };
    const navigate = `Navigate to ${route.path}`;
    const all: TestCase[] = [
      { ...common, id: `TS-FUNC-${slug}`, title: `${route.path} loads with a visible heading`, category: "functional", priority: index === 0 ? "high" : "medium", steps: [navigate], assertions: ["The response status is below 400", "A heading is visible", "No console errors or failed same-origin requests occur"], expectedOutcome: "The route is usable and identifiable", requiredEvidence: ["screenshot", "console", "network"] },
      { ...common, id: `TS-A11Y-${slug}`, title: `${route.path} has no blocking accessibility violations`, category: "accessibility", priority: "medium", steps: [navigate, "Run an axe-core accessibility scan"], assertions: ["No axe violations at or above policy.accessibilityFailOn"], expectedOutcome: "Assistive-technology users can use the route", requiredEvidence: ["screenshot", "accessibility"] },
      { ...common, id: `TS-RESP-${slug}`, title: `${route.path} has no horizontal overflow`, category: "responsive", priority: "medium", steps: [navigate, "Measure document width at each viewport profile"], assertions: ["The document does not overflow horizontally"], expectedOutcome: "Content fits every configured viewport", requiredEvidence: ["screenshot"] },
      { ...common, id: `TS-UI-${slug}`, title: `${route.path} matches its approved visual baseline`, category: "ui", priority: "low", preconditions: ["An approved visual baseline exists"], steps: [navigate, "Capture a full-page screenshot and diff it against the baseline"], assertions: ["Changed pixels stay within policy.visualMaxDiffRatio"], expectedOutcome: "Visual regressions are detected", requiredEvidence: ["screenshot"] }
    ];
    return all.filter(item => categories.has(item.category));
  });
  const all = [...(options.journeys ?? []), ...cases.map(item => ({ ...item, origin: "deterministic" as const }))];
  const limited = options.maxCases ? all.slice(0, options.maxCases) : all;
  return { schemaVersion: 1, id: randomUUID(), generatedAt: new Date().toISOString(), cases: limited };
}

export function createPlanFromDiscovery(discovery: DiscoveryResult, options: PlanOptions = {}): TestPlan {
  return createPlanForRoutes(discovery.routes.map(route => ({ path: route.path, feature: route.heading || route.title || route.path })), options);
}
