import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { HttpTestDataProvider } from "../../src/core/http-test-data.js";

test("HTTP test-data provider sets up and cleans up bounded fixtures", async () => {
  let cleaned = 0;
  const server = createServer((request, response) => { if (request.url === "/setup") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ id: "fixture-1", user: "synthetic" })); } else if (request.url === "/cleanup") { cleaned++; response.writeHead(204); response.end(); } else { response.writeHead(404); response.end(); } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.equal(typeof address, "object"); const base = `http://127.0.0.1:${(address as { port: number }).port}`;
  const provider = new HttpTestDataProvider(`${base}/setup`, `${base}/cleanup`, undefined, 1000); const fixture = await provider.setup(); await provider.cleanup(fixture); assert.equal(fixture.id, "fixture-1"); assert.equal(cleaned, 1); await new Promise<void>(resolve => server.close(() => resolve()));
});
