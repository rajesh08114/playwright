import type { ApplicationTarget } from "../core/contracts.js";
import { launchBrowser } from "../browser-runtime/runner.js";
import { redactSensitive } from "../evidence/redact.js";
import type { PageSnapshot } from "./provider.js";

/**
 * Captures an accessibility-tree snapshot of each route: roles, names, and visible text, not raw HTML. Secrets
 * matched by the evidence redactor are removed and each snapshot is truncated to maxChars before leaving the machine.
 */
export async function snapshotRoutes(target: ApplicationTarget, paths: string[], maxChars: number): Promise<{ snapshots: PageSnapshot[]; warnings: string[] }> {
  const allowed = new Set(target.allowedOrigins.map(origin => new URL(origin).origin));
  const snapshots: PageSnapshot[] = [], warnings: string[] = [];
  const browser = await launchBrowser(target);
  try {
    const context = await browser.newContext({ baseURL: target.baseUrl, viewport: target.viewport, storageState: target.storageStatePath });
    await context.route("**/*", route => { const url = new URL(route.request().url()); return allowed.has(url.origin) || ["data:", "blob:"].includes(url.protocol) ? route.continue() : route.abort("blockedbyclient"); });
    for (const path of paths) {
      const page = await context.newPage();
      page.setDefaultNavigationTimeout(target.navigationTimeoutMs);
      try {
        await page.goto(new URL(path, target.baseUrl).href, { waitUntil: "load" });
        await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
        const full = redactSensitive(await page.locator("body").ariaSnapshot({ timeout: target.actionTimeoutMs }));
        snapshots.push({ path, title: await page.title(), snapshot: full.slice(0, maxChars), truncated: full.length > maxChars });
      } catch (error) { warnings.push(`${path}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`); }
      finally { await page.close().catch(() => undefined); }
    }
    await context.close();
  } finally { await browser.close(); }
  return { snapshots, warnings };
}
