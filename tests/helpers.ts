import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/** Creates an isolated project directory with a testswarm.config.json built from `config`. */
export async function tempProject(config: Record<string, unknown> = {}, prefix = "testswarm-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const base = { schemaVersion: 1, name: "test-project", ...config };
  await writeFile(join(dir, "testswarm.config.json"), JSON.stringify(base, null, 2));
  return dir;
}

export async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export async function close(server: Server) { await new Promise<void>(resolve => server.close(() => resolve())); }

export function targetFor(baseUrl: string, extra: Record<string, unknown> = {}) {
  return { baseUrl, allowedOrigins: [baseUrl], startPath: "/", ...extra };
}
