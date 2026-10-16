import test from "node:test";
import assert from "node:assert/strict";
import { runDoctor } from "../../src/core/doctor.js";

test("doctor returns structured preflight checks", async () => { const result = await runDoctor(); assert.equal(result.schemaVersion, 1); assert.equal(Array.isArray(result.checks), true); assert.equal(result.checks.some(check => check.name === "sqlite"), true); });
