import { createHash } from "node:crypto";
import { Action, Journey, Locator } from "../core/contracts.js";

/** What the model sees for one route: an accessibility-tree snapshot, redacted and truncated. Untrusted content. */
export interface PageSnapshot { path: string; title: string; snapshot: string; truncated: boolean; }

/** One step as returned by the model: a flat, nullable shape that maps onto the Action contract. */
export interface RawStep {
  type: "goto" | "click" | "fill" | "select" | "check" | "press" | "expectVisible" | "expectText" | "expectUrl" | "expectTitle";
  locatorKind: "role" | "label" | "text" | "placeholder" | "testId" | null;
  locatorValue: string | null;
  roleName: string | null;
  value: string | null;
  path: string | null;
  key: string | null;
}
export interface RawJourney { id: string; title: string; startPath: string; priority: "critical" | "high" | "medium" | "low"; rationale: string; steps: RawStep[]; }

export interface ProposalUsage { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; model: string; }
export interface JourneyProposer {
  readonly name: string;
  propose(snapshots: PageSnapshot[], options: { maxJourneysPerRoute: number }): Promise<{ journeys: RawJourney[]; usage?: ProposalUsage }>;
}

export class DisabledJourneyProposer implements JourneyProposer {
  readonly name = "disabled";
  async propose(): Promise<never> { throw new Error('Model-assisted planning is disabled. Set "llm": { "enabled": true } in testswarm.config.json to use it.'); }
}

function toLocator(step: RawStep): Locator | undefined {
  const value = step.locatorValue?.trim();
  if (!step.locatorKind || !value) return undefined;
  switch (step.locatorKind) {
    case "role": return { role: value, ...(step.roleName ? { name: step.roleName } : {}) };
    case "label": return { label: value };
    case "text": return { text: value };
    case "placeholder": return { placeholder: value };
    case "testId": return { testId: value };
  }
}

function toAction(step: RawStep): Action | undefined {
  const target = toLocator(step);
  const candidate = (() => {
    switch (step.type) {
      case "goto": return { type: "goto", path: step.path };
      case "click": return { type: "click", target };
      case "fill": return { type: "fill", target, value: step.value ?? "" };
      case "select": return { type: "select", target, value: step.value };
      case "check": return { type: "check", target, checked: true };
      case "press": return { type: "press", key: step.key, ...(target ? { target } : {}) };
      case "expectVisible": return { type: "expectVisible", target };
      case "expectText": return { type: "expectText", target, text: step.value };
      case "expectUrl": return { type: "expectUrl", path: step.path };
      case "expectTitle": return { type: "expectTitle", text: step.value };
    }
  })();
  const parsed = Action.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

/**
 * A generated journey is only "none" (safe to run by default) when it navigates, follows links, and checks.
 * Typing, selecting, pressing keys, or clicking anything but a link may change application state.
 */
export function classifyGenerated(steps: Action[]): Journey["destructive"] {
  const safe = steps.every(step => step.type === "goto" || step.type.startsWith("expect") || step.type === "waitFor" || (step.type === "click" && "role" in step.target && step.target.role === "link"));
  return safe ? "none" : "reversible";
}

/**
 * Converts model output into validated journeys. Journeys with any invalid step, no assertion, or a start path not
 * among the snapshotted routes are rejected (with a reason) instead of repaired.
 */
export function validateProposals(raw: RawJourney[], knownPaths: Set<string>): { journeys: Journey[]; rejected: Array<{ id: string; reason: string }> } {
  const journeys: Journey[] = [], rejected: Array<{ id: string; reason: string }> = [];
  const ids = new Set<string>();
  for (const item of raw) {
    const steps = item.steps.map(toAction);
    const reject = (reason: string) => rejected.push({ id: item.id, reason });
    if (!knownPaths.has(item.startPath)) { reject(`start path ${item.startPath} was not snapshotted`); continue; }
    const invalid = steps.findIndex(step => !step);
    if (invalid >= 0) { reject(`step ${invalid + 1} (${item.steps[invalid].type}) is not a valid action`); continue; }
    const actions = steps as Action[];
    if (!actions.some(step => step.type.startsWith("expect"))) { reject("journey has no assertion"); continue; }
    // Stable, collision-free id derived from the content so re-proposals of the same journey keep their id.
    let id = `ai-${item.id.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || createHash("sha256").update(JSON.stringify(actions)).digest("hex").slice(0, 8)}`;
    while (ids.has(id)) id = `${id}-${ids.size}`;
    ids.add(id);
    const parsed = Journey.safeParse({ id, title: item.title, startPath: item.startPath, priority: item.priority, destructive: classifyGenerated(actions), steps: actions });
    if (parsed.success) journeys.push(parsed.data); else reject(parsed.error.issues[0]?.message ?? "invalid journey");
  }
  return { journeys, rejected };
}
