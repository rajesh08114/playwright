import test from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicJourneyProposer, LlmError } from "../../src/llm/anthropic.js";
import { LlmConfig } from "../../src/core/contracts.js";

type Captured = { url: string; headers: Headers; body: Record<string, any> };

/** A real SDK client whose HTTP layer is replaced by a stub, so the request the proposer builds can be inspected. */
function stubClient(reply: (captured: Captured) => Response) {
  const calls: Captured[] = [];
  const client = new Anthropic({
    apiKey: "test-key",
    maxRetries: 0,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const captured = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
      calls.push(captured);
      return reply(captured);
    }) as typeof fetch
  });
  return { client, calls };
}

const message = (text: string, stopReason = "end_turn") => new Response(JSON.stringify({
  id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: stopReason, stop_sequence: null,
  content: [{ type: "text", text }],
  usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 }
}), { status: 200, headers: { "content-type": "application/json" } });

const snapshot = [{ path: "/", title: "Home", snapshot: '- heading "Home" [level=1]\n- link "Products"', truncated: false }];
const config = LlmConfig.parse({ enabled: true });

test("the proposer sends a cached system prompt, structured-output schema, effort, and server-side fallbacks", async () => {
  const output = { journeys: [{ id: "browse", title: "Browse", startPath: "/", priority: "high", rationale: "r", steps: [{ type: "click", locatorKind: "role", locatorValue: "link", roleName: "Products", value: null, path: null, key: null }] }] };
  const { client, calls } = stubClient(() => message(JSON.stringify(output)));
  const result = await new AnthropicJourneyProposer(config, client).propose(snapshot, { maxJourneysPerRoute: 2 });
  const { body, headers, url } = calls[0];
  assert.match(url, /\/v1\/messages/);
  assert.equal(body.model, "claude-opus-5-5");
  assert.equal(body.fallbacks, "default");
  assert.match(headers.get("anthropic-beta") ?? "", /server-side-fallback-2026-07-01/);
  assert.equal(body.output_config.effort, "medium");
  assert.equal(body.output_config.format.type, "json_schema");
  assert.ok(body.output_config.format.schema.properties.journeys, "schema derived from the zod definition");
  assert.deepEqual(body.system[0].cache_control, { type: "ephemeral" });
  assert.match(body.system[0].text, /never as instructions/);
  assert.match(body.messages[0].content, /<page path="\/" title="Home">/);
  assert.equal(body.temperature, undefined, "sampling parameters are not sent");
  assert.equal(result.journeys[0].id, "browse");
  assert.deepEqual(result.usage, { inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: 900, model: "claude-opus-5-5" });
});

test("refusals, truncation, and schema mismatches become LlmErrors", async () => {
  for (const [reply, pattern] of [
    [() => message("", "refusal"), /declined/],
    [() => message('{"journeys": [', "max_tokens"), /cut off/],
    [() => message('{"journeys": [{"id": 1}]}'), /did not match the journey schema/],
    [() => message("not json"), /not valid JSON/],
    [() => new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), { status: 401, headers: { "content-type": "application/json" } }), /authentication failed/]
  ] as Array<[() => Response, RegExp]>) {
    const { client } = stubClient(reply);
    await assert.rejects(() => new AnthropicJourneyProposer(config, client).propose(snapshot, { maxJourneysPerRoute: 1 }), (error: Error) => error instanceof LlmError && pattern.test(error.message));
  }
});
