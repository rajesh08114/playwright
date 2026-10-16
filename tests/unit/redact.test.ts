import test from "node:test";
import assert from "node:assert/strict";
import { redactSensitive } from "../../src/evidence/redact.js";

test("evidence redaction removes common credential forms", () => { const value = redactSensitive("Authorization: Bearer abc123 cookie=SID=secret api_key=topsecret"); assert.equal(value.includes("abc123"), false); assert.equal(value.includes("topsecret"), false); assert.equal(value.includes("[REDACTED]"), true); });
