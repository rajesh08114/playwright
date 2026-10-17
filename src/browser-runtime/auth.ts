import { chmod, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProjectConfiguration } from "../core/contracts.js";
import { runActions } from "./actions.js";
import { launchBrowser } from "./runner.js";

export class LoginError extends Error { override name = "LoginError"; }

/**
 * Runs the configured login steps and saves the browser session (cookies and local storage) as a Playwright
 * storage-state file, reusing a saved session while it is younger than auth.maxAgeMinutes. Returns the file path,
 * or undefined when no auth is configured. Credentials come only from environment variables; no trace is recorded.
 */
export async function ensureAuthenticated(config: ProjectConfiguration, options: { force?: boolean } = {}): Promise<string | undefined> {
  const auth = config.auth;
  if (!auth) return config.target.storageStatePath;
  const file = auth.storageStatePath!;
  const allowed = new Set(config.target.allowedOrigins.map(origin => new URL(origin).origin));
  if (!options.force) {
    const info = await stat(file).catch(() => undefined);
    // A young file can still hold a session the server has dropped (restart, logout elsewhere); check before reusing.
    if (info && Date.now() - info.mtimeMs < auth.maxAgeMinutes * 60_000 && await sessionStillValid(config, file, allowed)) return file;
  }
  const browser = await launchBrowser(config.target);
  try {
    const context = await browser.newContext({ baseURL: config.target.baseUrl, viewport: config.target.viewport });
    await context.route("**/*", route => { const url = new URL(route.request().url()); return allowed.has(url.origin) || ["data:", "blob:"].includes(url.protocol) ? route.continue() : route.abort("blockedbyclient"); });
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(config.target.navigationTimeoutMs);
    const loginUrl = new URL(auth.loginPath, config.target.baseUrl).href;
    const response = await page.goto(loginUrl, { waitUntil: "load" }).catch((error: Error) => { throw new LoginError(`Could not open the login page ${loginUrl}: ${error.message.split("\n")[0]}. Is the application running?`); });
    if (response && response.status() >= 400) throw new LoginError(`Login page returned HTTP ${response.status()}`);
    try {
      await runActions(page, auth.steps, { baseUrl: config.target.baseUrl, allowedOrigins: allowed, timeoutMs: config.target.actionTimeoutMs });
      if (auth.successPath) await runActions(page, [{ type: "expectUrl", path: auth.successPath }], { baseUrl: config.target.baseUrl, allowedOrigins: allowed, timeoutMs: config.target.navigationTimeoutMs });
    } catch (error) { throw new LoginError(`Login failed: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`); }
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await context.storageState({ path: file });
    await chmod(file, 0o600).catch(() => undefined);
    await context.close();
    return file;
  } finally { await browser.close(); }
}

/**
 * True when the saved session still reaches auth.successPath without being sent back to the login page.
 * Without a path-like successPath there is nothing to check against, so the saved session is trusted.
 */
async function sessionStillValid(config: ProjectConfiguration, file: string, allowed: Set<string>): Promise<boolean> {
  const successPath = config.auth?.successPath;
  if (!successPath?.startsWith("/")) return true;
  const browser = await launchBrowser(config.target).catch(() => undefined);
  if (!browser) return true; // the caller's own launch will report the browser problem
  try {
    const context = await browser.newContext({ baseURL: config.target.baseUrl, storageState: file });
    await context.route("**/*", route => { const url = new URL(route.request().url()); return allowed.has(url.origin) || ["data:", "blob:"].includes(url.protocol) ? route.continue() : route.abort("blockedbyclient"); });
    const page = await context.newPage();
    const response = await page.goto(new URL(successPath, config.target.baseUrl).href, { waitUntil: "load", timeout: config.target.navigationTimeoutMs });
    const landed = new URL(page.url());
    return Boolean(response && response.status() < 400) && `${landed.pathname}${landed.search}`.startsWith(successPath);
  } catch { return false; }
  finally { await browser.close().catch(() => undefined); }
}
