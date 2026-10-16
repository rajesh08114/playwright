import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { ApplicationTarget, DiscoveryResult, DiscoveredRoute } from "../core/contracts.js";

export async function discoverApplication(target: ApplicationTarget, budget = 10): Promise<DiscoveryResult> {
  const startedAt = new Date().toISOString();
  const origin = new URL(target.baseUrl).origin;
  const queue = [new URL(target.startPath, target.baseUrl).href];
  const seen = new Set<string>();
  const routes: DiscoveredRoute[] = [];
  const warnings: string[] = [];
  const browser = await chromium.launch({ headless: true, executablePath: target.executablePath });
  try {
    while (queue.length && seen.size < budget) {
      const href = queue.shift()!;
      const url = new URL(href);
      if (url.origin !== origin || seen.has(url.pathname)) continue;
      seen.add(url.pathname);
      const context = await browser.newContext({ baseURL: target.baseUrl, viewport: target.viewport, storageState: target.storageStatePath });
      const page = await context.newPage();
      await page.route("**/*", async route => { const requestUrl = new URL(route.request().url()); if (requestUrl.origin === origin || ["data:", "blob:"].includes(requestUrl.protocol)) await route.continue(); else await route.abort("blockedbyclient"); });
      page.setDefaultNavigationTimeout(target.navigationTimeoutMs);
      try {
        await page.goto(href, { waitUntil: "domcontentloaded" });
        if (new URL(page.url()).origin !== origin) throw new Error("Navigation redirect left the allowed origin");
        const links = await page.locator("a[href]").evaluateAll(nodes => nodes.map(n => (n as HTMLAnchorElement).href));
        const localPaths = links.filter(link => { try { return new URL(link).origin === origin; } catch { return false; } }).map(link => new URL(link).pathname);
        for (const path of localPaths) if (!seen.has(path) && !queue.some(x => new URL(x).pathname === path)) queue.push(new URL(path, target.baseUrl).href);
        routes.push({ path: url.pathname, title: await page.title(), heading: await page.getByRole("heading").first().textContent().catch(() => undefined) ?? undefined, source: "browser-observed", confidence: 0.9, links: [...new Set(localPaths)], forms: await page.locator("form").count(), interactiveElements: await page.locator("button, input, select, textarea, [role=button]").count() });
      } catch (error) { warnings.push(`${url.pathname}: ${error instanceof Error ? error.message : String(error)}`); }
      await context.close();
    }
  } finally { await browser.close(); }
  const result: DiscoveryResult = { schemaVersion: 1, startedAt, finishedAt: new Date().toISOString(), routes, features: routes.map(route => ({ id: randomUUID(), name: route.heading || route.title || route.path, routePaths: [route.path], confidence: route.confidence, observations: [`${route.forms} form(s), ${route.interactiveElements} interactive element(s)`] })), warnings };
  return result;
}
