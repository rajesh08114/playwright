import { readFile } from "node:fs/promises";
import { ProjectConfiguration } from "./contracts.js";

export async function loadConfig(path = process.env.TESTSWARM_CONFIG ?? "testswarm.config.json") {
  const raw = JSON.parse(await readFile(path, "utf8"));
  const parsed = ProjectConfiguration.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid configuration: ${parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const base = new URL(parsed.data.target.baseUrl);
  const origins = parsed.data.target.allowedOrigins.map(x => new URL(x).origin);
  if (!origins.includes(base.origin)) throw new Error("target.baseUrl must belong to allowedOrigins");
  if (origins.some(origin => { const url = new URL(origin); return ["0.0.0.0", "::", "169.254.169.254"].includes(url.hostname); })) throw new Error("Wildcard, metadata, and unspecified network origins are not permitted");
  if (parsed.data.testData && !origins.includes(new URL(parsed.data.testData.setupUrl).origin)) throw new Error("testData.setupUrl must belong to allowedOrigins");
  if (parsed.data.testData?.cleanupUrl && !origins.includes(new URL(parsed.data.testData.cleanupUrl).origin)) throw new Error("testData.cleanupUrl must belong to allowedOrigins");
  return parsed.data;
}
