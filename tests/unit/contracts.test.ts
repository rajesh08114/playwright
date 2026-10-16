import test from "node:test";
import assert from "node:assert/strict";
import { ApplicationTarget } from "../../src/core/contracts.js";
import { loadConfig } from "../../src/core/config.js";
import { mkdir, writeFile } from "node:fs/promises";
test("target schema rejects malformed origins", () => { assert.equal(ApplicationTarget.safeParse({ baseUrl: "not-a-url", allowedOrigins: [], startPath: "/" }).success, false); });
test("project policy rejects metadata origins", async () => { await mkdir(".testswarm", { recursive: true }); const file = ".testswarm/security-test.json"; await writeFile(file, JSON.stringify({ schemaVersion: 1, name: "x", target: { baseUrl: "http://169.254.169.254", allowedOrigins: ["http://169.254.169.254"], startPath: "/" } })); await assert.rejects(() => loadConfig(file), /not permitted/); });
