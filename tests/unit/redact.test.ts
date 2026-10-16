import test from "node:test";
import assert from "node:assert/strict";
import { redactSensitive } from "../../src/evidence/redact.js";

const cases: Array<[string, string]> = [
  ["Authorization: Bearer abc123", "abc123"],
  ["cookie=SID=secret", "SID=secret"],
  ["api_key=topsecret", "topsecret"],
  ['{"password":"hunter2"}', "hunter2"],
  ["GET https://x.test/cb?code=xyz789&state=ok", "xyz789"],
  ["token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "dozjgNryP4J3"],
  ["key sk_live_abcdefghijklmnop", "abcdefghijklmnop"],
  ["gh token ghp_abcdefghijklmnopqrstuvwx1234", "ghp_abcdefghij"]
];

for (const [input, secret] of cases) {
  test(`redaction removes ${secret.slice(0, 12)}`, () => {
    const value = redactSensitive(input);
    assert.equal(value.includes(secret), false, value);
    assert.match(value, /REDACTED/);
  });
}

test("redaction leaves ordinary text alone", () => {
  assert.equal(redactSensitive("GET /products?page=2: net::ERR_FAILED"), "GET /products?page=2: net::ERR_FAILED");
});
