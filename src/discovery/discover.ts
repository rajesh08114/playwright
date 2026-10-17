import { randomUUID } from "node:crypto";
import { ApplicationTarget, DiscoveryResult, DiscoveredRoute } from "../core/contracts.js";
import { launchBrowser } from "../browser-runtime/runner.js";

// Links that should never be followed automatically: they mutate state or end the session.
const UNSAFE_PATH = /\/(?:log-?out|sign-?out|delete|remove|destroy|unsubscribe)(?:\/|$|\?)/i;
const ASSET_PATH = /\.(?:png|jpe?g|gif|svg|webp|ico|pdf|zip|gz|css|js|mjs|map|json|xml|txt|woff2?|ttf|mp4|webm|mp3)$/i;

/**
 * Route key: path plus query. Fragments are dropped (in-page anchors) except hash-router routes ("#/about",
 * "#!/about"), which are separate pages in single-page apps.
 */
export function routeKey(url: URL) { return `${url.pathname}${url.search}${/^#!?\//.test(url.hash) ? url.hash : ""}`; }

async function sitemapPaths(target: ApplicationTarget, origin: string, signal: AbortSignal): Promise<string[]> {
  try {
    const response = await fetch(new URL("/sitemap.xml", target.baseUrl), { signal, redirect: "error" });
    if (!response.ok) return [];
    const xml = await response.text();
    return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(match => { try { const url = new URL(match[1]); return url.origin === origin ? routeKey(url) : undefined; } catch { return undefined; } }).filter((item): item is string => Boolean(item));
  } catch { return []; }
}

/**
 * Breadth-first, same-origin crawl. Follows anchors (including ones rendered by client-side routers once the page
 * has loaded), seeds from target.routes and sitemap.xml, never submits forms, and skips links that look destructive.
 */
export async function discoverApplication(target: ApplicationTarget, budget = 25): Promise<DiscoveryResult> {
  const startedAt = new Date().toISOString();
  const origin = new URL(target.baseUrl).origin;
  const allowed = new Set(target.allowedOrigins.map(item => new URL(item).origin));
  const warnings: string[] = [];
  const routes: DiscoveredRoute[] = [];
  const queued = new Set<string>();
  const queue: Array<{ key: string; source: DiscoveredRoute["source"] }> = [];
  const enqueue = (key: string, source: DiscoveredRoute["source"]) => {
    if (queued.has(key)) return;
    if (UNSAFE_PATH.test(key)) { warnings.push(`${key}: skipped, looks state-changing`); queued.add(key); return; }
    if (ASSET_PATH.test(new URL(key, origin).pathname)) { queued.add(key); return; }
    queued.add(key); queue.push({ key, source });
  };
  enqueue(routeKey(new URL(target.startPath, target.baseUrl)), "browser-observed");
  for (const route of target.routes) enqueue(routeKey(new URL(route, target.baseUrl)), "configured");
  const sitemapTimeout = AbortSignal.timeout(Math.min(target.navigationTimeoutMs, 10_000));
  for (const path of await sitemapPaths(target, origin, sitemapTimeout)) enqueue(path, "configured");

  const browser = await launchBrowser(target);
  try {
    const context = await browser.newContext({ baseURL: target.baseUrl, viewport: target.viewport, storageState: target.storageStatePath });
    await context.route("**/*", async route => { const requestUrl = new URL(route.request().url()); if (allowed.has(requestUrl.origin) || ["data:", "blob:"].includes(requestUrl.protocol)) await route.continue(); else await route.abort("blockedbyclient"); });
    while (queue.length && routes.length < budget) {
      const { key, source } = queue.shift()!;
      const page = await context.newPage();
      page.setDefaultNavigationTimeout(target.navigationTimeoutMs);
      page.setDefaultTimeout(target.actionTimeoutMs);
      try {
        const response = await page.goto(new URL(key, target.baseUrl).href, { waitUntil: "load" });
        await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
        if (new URL(page.url()).origin !== origin) throw new Error("Navigation redirect left the target origin");
        if (response && response.status() >= 400) warnings.push(`${key}: HTTP ${response.status()}`);
        const links = await page.locator("a[href]").evaluateAll(nodes => nodes.map(node => (node as HTMLAnchorElement).href));
        const localKeys = [...new Set(links.flatMap(link => { try { const url = new URL(link); return url.origin === origin && ["http:", "https:"].includes(url.protocol) ? [routeKey(url)] : []; } catch { return []; } }))];
        for (const link of localKeys) enqueue(link, "browser-observed");
        routes.push({
          path: key,
          title: await page.title(),
          heading: (await page.getByRole("heading").first().textContent({ timeout: 1000 }).catch(() => null))?.trim() || undefined,
          source,
          confidence: response && response.status() < 400 ? 0.9 : 0.5,
          links: localKeys,
          forms: await page.locator("form").count(),
          interactiveElements: await page.locator("button, input, select, textarea, [role=button], a[href]").count()
        });
      } catch (error) { warnings.push(`${key}: ${error instanceof Error ? error.message : String(error)}`); }
      finally { await page.close().catch(() => undefined); }
    }
    if (queue.length) warnings.push(`Route budget of ${budget} reached; ${queue.length} discovered route(s) were not visited. Raise budgets.maxRoutes to include them.`);
    await context.close();
  } finally { await browser.close(); }
  return {
    schemaVersion: 1, startedAt, finishedAt: new Date().toISOString(), routes,
    features: routes.map(route => ({ id: randomUUID(), name: route.heading || route.title || route.path, routePaths: [route.path], confidence: route.confidence, observations: [`${route.forms} form(s), ${route.interactiveElements} interactive element(s)`] })),
    warnings
  };
}
