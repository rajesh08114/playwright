import test from "node:test";
import assert from "node:assert/strict";
import { functionalAgent, uiAgent, accessibilityAgent } from "../../src/agents/agent.js";

test("specialist agents have explicit scopes", () => { assert.deepEqual(functionalAgent.categories, ["functional"]); assert.deepEqual(uiAgent.categories, ["ui", "responsive"]); assert.deepEqual(accessibilityAgent.categories, ["accessibility"]); });
