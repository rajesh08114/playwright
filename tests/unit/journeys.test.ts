import test from "node:test";
import assert from "node:assert/strict";
import { Action, Journey } from "../../src/core/contracts.js";
import { describeAction } from "../../src/browser-runtime/actions.js";
import { journeysToCases } from "../../src/planner/planner.js";
import { classifyGenerated, validateProposals, type RawJourney, type RawStep } from "../../src/llm/provider.js";
import { loadConfig } from "../../src/core/config.js";
import { tempProject } from "../helpers.js";

test("actions are a closed set: unknown step types and extra keys are rejected", () => {
  assert.equal(Action.safeParse({ type: "click", target: { role: "button", name: "Go" } }).success, true);
  assert.equal(Action.safeParse({ type: "evaluate", script: "alert(1)" }).success, false);
  assert.equal(Action.safeParse({ type: "click", target: { role: "button" }, script: "x" }).success, false);
  assert.equal(Action.safeParse({ type: "click", target: { role: "button", css: "#x" } }).success, false, "one locator strategy per target");
});

test("fill takes exactly one of value or valueFromEnv", () => {
  const target = { label: "Password" };
  assert.equal(Action.safeParse({ type: "fill", target, value: "x" }).success, true);
  assert.equal(Action.safeParse({ type: "fill", target, valueFromEnv: "DEMO_PASSWORD" }).success, true);
  assert.equal(Action.safeParse({ type: "fill", target }).success, false);
  assert.equal(Action.safeParse({ type: "fill", target, value: "x", valueFromEnv: "DEMO_PASSWORD" }).success, false);
  assert.equal(Action.safeParse({ type: "fill", target, valueFromEnv: "lower-case" }).success, false);
});

test("step descriptions never contain secret values", () => {
  const description = describeAction({ type: "fill", target: { label: "Password" }, valueFromEnv: "DEMO_PASSWORD" });
  assert.equal(description, 'fill label "Password" with $DEMO_PASSWORD');
});

test("journeys become journey cases that carry their actions", () => {
  const journey = Journey.parse({ id: "search", title: "Search finds mugs", startPath: "/search", steps: [{ type: "fill", target: { label: "Search products" }, value: "mug" }, { type: "press", key: "Enter", target: { label: "Search products" } }, { type: "expectText", target: { role: "heading", name: "Results for mug" }, text: "mug" }] });
  const [testCase] = journeysToCases([journey]);
  assert.equal(testCase.id, "TS-JRNY-search");
  assert.equal(testCase.category, "journey");
  assert.equal(testCase.steps[0], "Navigate to /search");
  assert.equal(testCase.actions?.length, 3);
  assert.equal(testCase.origin, "configured");
});

test("duplicate journey ids are a configuration error", async () => {
  const journey = { id: "same", title: "t", steps: [{ type: "expectTitle", text: "x" }] };
  const dir = await tempProject({ target: { baseUrl: "http://127.0.0.1:3999", allowedOrigins: ["http://127.0.0.1:3999"], startPath: "/" }, journeys: [journey, journey] });
  await assert.rejects(() => loadConfig(undefined, dir), /Duplicate journey id/);
});

const step = (overrides: Partial<RawStep>): RawStep => ({ type: "expectVisible", locatorKind: null, locatorValue: null, roleName: null, value: null, path: null, key: null, ...overrides });
const raw = (overrides: Partial<RawJourney>): RawJourney => ({ id: "j", title: "Journey", startPath: "/", priority: "medium", rationale: "r", steps: [step({ locatorKind: "role", locatorValue: "heading", roleName: "Home" })], ...overrides });

test("model proposals are validated, never repaired", () => {
  const { journeys, rejected } = validateProposals([
    raw({ id: "ok" }),
    raw({ id: "unknown-page", startPath: "/admin" }),
    raw({ id: "bad-step", steps: [step({ type: "click" }), step({ locatorKind: "text", locatorValue: "x" })] }),
    raw({ id: "no-assert", steps: [step({ type: "click", locatorKind: "role", locatorValue: "link", roleName: "Products" })] })
  ], new Set(["/"]));
  assert.deepEqual(journeys.map(item => item.id), ["ai-ok"]);
  assert.deepEqual(rejected.map(item => item.id), ["unknown-page", "bad-step", "no-assert"]);
  assert.match(rejected[1].reason, /step 1/);
});

test("generated journeys that type, select, press, or click non-links are marked reversible", () => {
  const link = { type: "click", target: { role: "link", name: "Products" } } as const;
  const expectStep = { type: "expectUrl", path: "/products" } as const;
  assert.equal(classifyGenerated([link, expectStep]), "none");
  assert.equal(classifyGenerated([{ type: "click", target: { role: "button", name: "Delete" } }, expectStep]), "reversible");
  assert.equal(classifyGenerated([{ type: "fill", target: { label: "Email" }, value: "a@b.c" }, expectStep]), "reversible");
  const { journeys } = validateProposals([raw({ id: "typing", steps: [step({ type: "fill", locatorKind: "label", locatorValue: "Email", value: "test@example.com" }), step({ type: "expectUrl", path: "/done" })] })], new Set(["/"]));
  assert.equal(journeys[0].destructive, "reversible");
});
