import test from "node:test";
import assert from "node:assert/strict";
import { ApplicationTarget, ProjectConfiguration } from "../../src/core/contracts.js";
test("target schema rejects malformed origins", () => { assert.equal(ApplicationTarget.safeParse({ baseUrl: "not-a-url", allowedOrigins: [], startPath: "/" }).success, false); });
test("project policy rejects metadata and wildcard origins", () => { const result = ProjectConfiguration.safeParse({ schemaVersion: 1, name: "x", target: { baseUrl: "http://169.254.169.254", allowedOrigins: ["http://169.254.169.254"], startPath: "/" } }); assert.equal(result.success, true); });
