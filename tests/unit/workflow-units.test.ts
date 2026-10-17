import test from "node:test";
import assert from "node:assert/strict";
import { starterConfig } from "../../src/core/config.js";
import { routeKey } from "../../src/discovery/discover.js";
import { firstLine } from "../../src/browser-runtime/runner.js";

test("init keeps the base path of apps served under a sub-path", () => {
  assert.equal(starterConfig("http://127.0.0.1:3000/app/").target.startPath, "/app/");
  assert.equal(starterConfig("http://127.0.0.1:3000").target.startPath, "/");
  assert.equal(starterConfig("http://127.0.0.1:3000/app/").target.baseUrl, "http://127.0.0.1:3000");
});

test("route keys keep hash-router routes but drop in-page anchors", () => {
  assert.equal(routeKey(new URL("http://x.test/#/about")), "/#/about");
  assert.equal(routeKey(new URL("http://x.test/app#!/cart")), "/app#!/cart");
  assert.equal(routeKey(new URL("http://x.test/docs#install")), "/docs");
  assert.equal(routeKey(new URL("http://x.test/search?q=a#top")), "/search?q=a");
});

test("only the first line of Playwright errors is kept", () => {
  assert.equal(firstLine("page.goto: net::ERR_CONNECTION_REFUSED at http://x/\nCall log:\n  - navigating"), "page.goto: net::ERR_CONNECTION_REFUSED at http://x/");
});
