import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage, ToolMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { Engine } from "../../src/core/engine.js";
import { close, listen, targetFor, tempProject } from "../helpers.js";

const { createDemoServer } = await import(new URL("../../../fixtures/demo-app/app.mjs", import.meta.url).href) as { createDemoServer(): Server };

type Script = (messages: BaseMessage[], tools: string[]) => AIMessage;
let callId = 0;
const call = (name: string, args: Record<string, unknown>) => new AIMessage({ content: "", tool_calls: [{ id: `call_${++callId}`, name, args, type: "tool_call" }] });

/** A chat model whose replies come from a script that inspects the conversation, so the agent loop runs offline. */
class ScriptedChatModel extends BaseChatModel {
  toolNames: string[] = [];
  constructor(private readonly script: Script) { super({}); }
  _llmType() { return "scripted"; }
  override bindTools(tools: Array<{ name?: string }>) {
    const bound = new ScriptedChatModel(this.script);
    bound.toolNames = tools.map(item => item.name ?? "");
    return bound as never;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const message = this.script(messages, this.toolNames);
    message.usage_metadata = { input_tokens: 100, output_tokens: 10, total_tokens: 110 };
    return { generations: [{ message, text: typeof message.content === "string" ? message.content : "" }] };
  }
}

const toolResults = (messages: BaseMessage[], name: string) => messages.filter((item): item is ToolMessage => ToolMessage.isInstance(item) && item.name === name).map(item => String(item.content));

const cart = (count: string) => ({ startPath: "/products", steps: [{ type: "click", target: { role: "button", name: "Add to cart" } }, { type: "expectText", target: { testId: "cart-count" }, text: count }] });
const search = { startPath: "/search", steps: [{ type: "fill", target: { label: "Search products" }, value: "mug" }, { type: "press", key: "Enter", target: { label: "Search products" } }, { type: "expectText", target: { role: "heading", name: "Results for mug" }, text: "mug" }] };

/** Coordinator: list routes, delegate one route, finish. Explorer: snapshot, fail, self-correct, submit, report. */
const script: Script = (messages, tools) => {
  if (tools.includes("task")) {
    if (!toolResults(messages, "list_routes").length) return call("list_routes", {});
    if (!toolResults(messages, "task").length) return call("task", { description: "Explore route /products. Then explore /search.", subagent_type: "route-explorer" });
    return new AIMessage("Explored /products and /search: 1 verified journey, 1 for review, 1 candidate defect.");
  }
  const snapshots = toolResults(messages, "snapshot_page"), trials = toolResults(messages, "try_journey"), submitted = toolResults(messages, "submit_journey");
  if (!snapshots.length) return call("snapshot_page", { path: "/products" });
  if (trials.length === 0) return call("try_journey", cart("5"));
  if (trials.length === 1) return call("try_journey", cart("1"));
  if (trials.length === 2) return call("try_journey", search);
  if (submitted.length === 0) return call("submit_journey", { id: "Add To Cart", title: "Adding a product updates the cart", priority: "high", rationale: "core purchase path", ...cart("1") });
  if (submitted.length === 1) return call("submit_journey", { id: "search", title: "Search finds mugs", priority: "medium", rationale: "search is a main entry point", ...search });
  if (submitted.length === 2) return call("submit_journey", { id: "guess", title: "A journey that never ran", priority: "low", rationale: "x", ...cart("7") });
  if (!toolResults(messages, "report_finding").length) return call("report_finding", { path: "/products", summary: "Cart count is not announced as a status", steps: ["Click Add to cart"], observed: "aria-live polite span", expected: "status role", severity: "low" });
  return new AIMessage("Submitted add-to-cart (verified), search (for review), guess (unverified); reported 1 finding.");
};

let server: Server, baseUrl = "";
test.before(async () => { server = createDemoServer(); baseUrl = await listen(server); });
test.after(() => close(server));

test("against a disposable environment the agent self-corrects and only verified journeys join the plan", async () => {
  const transcript: string[] = [], coordinatorTools = new Set<string>();
  const recording: Script = (messages, tools) => {
    if (tools.includes("task")) tools.forEach(name => coordinatorTools.add(name));
    const reply = script(messages, tools);
    const last = messages.at(-1);
    if (last && ToolMessage.isInstance(last)) transcript.push(`${last.name}: ${String(last.content).split("\n")[0]}`);
    return reply;
  };
  const dir = await tempProject({ target: targetFor(baseUrl), budgets: { maxRetries: 0, maxConcurrency: 1 }, policy: { trace: "off", allowDestructiveActions: true }, llm: { enabled: true, maxRoutes: 6, agent: { maxTrials: 10 } } });
  const engine = new Engine({ projectDir: dir, agentModel: new ScriptedChatModel(recording) });
  try {
    const result = await engine.planWithAgent();
    assert.ok(transcript.some(line => /^try_journey: FAILED: Step 2 \(expect test id "cart-count" to contain "5"\) failed: text was "1"/.test(line)), transcript.join("\n"));
    assert.ok(transcript.some(line => /^try_journey: PASSED/.test(line)));
    assert.ok(coordinatorTools.has("write_todos") && coordinatorTools.has("list_routes"), [...coordinatorTools].join(","));
    assert.equal(result.verifiedJourneys, 2);
    assert.deepEqual(result.forReview.map(item => item.id), ["agent-guess"]);
    assert.deepEqual(result.trials, { total: 3, passed: 2, failed: 1, refused: 0 });
    assert.equal(result.findings, 1);
    assert.ok(result.usage.modelCalls >= 9 && result.usage.inputTokens === result.usage.modelCalls * 100, JSON.stringify(result.usage));
    const ids = result.plan.cases.map(item => item.id);
    assert.ok(ids.includes("TS-JRNY-agent-add-to-cart"));
    assert.ok(ids.includes("TS-JRNY-agent-search"));
    assert.ok(!ids.includes("TS-JRNY-agent-guess"), "unverified journeys stay out of the plan");
    const review = JSON.parse(await readFile(result.file, "utf8"));
    assert.equal(review.submissions.length, 3);
    assert.match(review.summary, /1 verified journey/);
    // The verified journeys really run green as part of the plan.
    const run = await engine.run(result.plan.id);
    for (const id of ["TS-JRNY-agent-add-to-cart", "TS-JRNY-agent-search"]) {
      const journey = run.executions.find(item => item.testCaseId === id)!;
      assert.equal(journey.outcome, "passed", `${id}: ${journey.error}`);
    }
  } finally { engine.close(); }
});

test("by default the agent may only execute read-only journeys; interactive ones go to human review", async () => {
  const readOnly: Script = (messages, tools) => {
    if (tools.includes("task")) return toolResults(messages, "task").length ? new AIMessage("done") : toolResults(messages, "list_routes").length ? call("task", { description: "Explore /", subagent_type: "route-explorer" }) : call("list_routes", {});
    const trials = toolResults(messages, "try_journey"), submitted = toolResults(messages, "submit_journey");
    const browse = { startPath: "/", steps: [{ type: "click", target: { role: "link", name: "Products" } }, { type: "expectUrl", path: "/products" }, { type: "expectVisible", target: { role: "heading", name: "Products" } }] };
    if (trials.length === 0) return call("try_journey", cart("1"));
    if (trials.length === 1) return call("try_journey", browse);
    if (submitted.length === 0) return call("submit_journey", { id: "browse", title: "Home links to products", priority: "high", rationale: "navigation", ...browse });
    if (submitted.length === 1) return call("submit_journey", { id: "cart", title: "Add to cart", priority: "high", rationale: "purchase", ...cart("1") });
    return new AIMessage("done");
  };
  let explorerPrompt = "";
  const capture: Script = (messages, tools) => { if (!tools.includes("task")) explorerPrompt ||= messages[0]?.text ?? ""; return readOnly(messages, tools); };
  const dir = await tempProject({ target: targetFor(baseUrl), policy: { trace: "off" }, llm: { enabled: true } });
  const engine = new Engine({ projectDir: dir, agentModel: new ScriptedChatModel(capture) });
  try {
    const result = await engine.planWithAgent();
    assert.deepEqual(result.trials, { total: 1, passed: 1, failed: 0, refused: 1 });
    assert.equal(result.verifiedJourneys, 1);
    assert.deepEqual(result.forReview, [{ id: "agent-cart", executed: false, destructive: "reversible" }]);
    assert.match(explorerPrompt, /read-only for you/);
  } finally { engine.close(); }
});

test("the trial budget is enforced in the tool, not left to the model", async () => {
  const greedy: Script = (messages, tools) => {
    if (tools.includes("task")) return toolResults(messages, "task").length ? new AIMessage("done") : toolResults(messages, "list_routes").length ? call("task", { description: "Explore /products", subagent_type: "route-explorer" }) : call("list_routes", {});
    const trials = toolResults(messages, "try_journey");
    return trials.length < 5 ? call("try_journey", cart("1")) : new AIMessage(trials.at(-1)!);
  };
  const dir = await tempProject({ target: targetFor(baseUrl), policy: { trace: "off", allowDestructiveActions: true }, llm: { enabled: true, agent: { maxTrials: 2 } } });
  const engine = new Engine({ projectDir: dir, agentModel: new ScriptedChatModel(greedy) });
  try {
    const result = await engine.planWithAgent();
    assert.equal(result.trials.total, 2);
    const review = JSON.parse(await readFile(result.file, "utf8"));
    assert.equal(review.trials.total, 2);
  } finally { engine.close(); }
});

test("a runaway agent is stopped at the recursion limit and keeps its results", async () => {
  const loop: Script = (messages, tools) => tools.includes("task") ? call("list_routes", {}) : new AIMessage("x");
  const dir = await tempProject({ target: targetFor(baseUrl), policy: { trace: "off" }, llm: { enabled: true, agent: { recursionLimit: 12 } } });
  const engine = new Engine({ projectDir: dir, agentModel: new ScriptedChatModel(loop) });
  try {
    const result = await engine.planWithAgent();
    assert.match(result.stoppedEarly ?? "", /recursion limit of 12/);
    assert.equal(result.verifiedJourneys, 0);
  } finally { engine.close(); }
});

test("the agent never gets disk or shell access (keeps the braces advisory unreachable)", async () => {
  // fast-glob/micromatch (and the unpatched braces advisory) are only reachable through these deepagents backends.
  const files: string[] = [];
  const walk = async (dir: string) => { for (const entry of await readdir(dir, { withFileTypes: true })) entry.isDirectory() ? await walk(join(dir, entry.name)) : files.push(join(dir, entry.name)); };
  await walk(fileURLToPath(new URL("../../../src/", import.meta.url)));
  assert.ok(files.some(file => file.endsWith("explorer.ts")));
  for (const file of files.filter(item => item.endsWith(".ts"))) {
    assert.doesNotMatch(await readFile(file, "utf8"), /new (FilesystemBackend|LocalShellBackend)\b|import[^;]*\b(FilesystemBackend|LocalShellBackend|fast-glob|micromatch)\b/, file);
  }
});
