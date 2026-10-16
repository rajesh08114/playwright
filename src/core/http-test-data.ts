import { readFile } from "node:fs/promises";
import { TestDataFixture } from "./contracts.js";
import { TestDataProvider } from "./test-data.js";

export class HttpTestDataProvider implements TestDataProvider {
  constructor(private readonly setupUrl: string, private readonly cleanupUrl: string | undefined, private readonly fixturePath: string | undefined, private readonly timeoutMs: number) {}
  private async payload() { if (!this.fixturePath) return {}; return JSON.parse(await readFile(this.fixturePath, "utf8")); }
  async setup(signal?: AbortSignal): Promise<TestDataFixture> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs); if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
    try { const response = await fetch(this.setupUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(await this.payload()), signal: controller.signal }); if (!response.ok) throw new Error(`Test-data setup failed with HTTP ${response.status}`); const data = await response.json().catch(() => ({})); return { id: String(data.id ?? `http-${Date.now()}`), description: "HTTP-managed test data", data, cleanupRequired: Boolean(this.cleanupUrl) }; } finally { clearTimeout(timer); }
  }
  async cleanup(fixture: TestDataFixture, signal?: AbortSignal): Promise<void> { if (!this.cleanupUrl) return; const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs); if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true }); try { const response = await fetch(this.cleanupUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fixture), signal: controller.signal }); if (!response.ok) throw new Error(`Test-data cleanup failed with HTTP ${response.status}`); } finally { clearTimeout(timer); } }
}
