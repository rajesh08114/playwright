import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { chromium, firefox, webkit, type Browser, type BrowserType, type LaunchOptions } from "playwright";
import type { ApplicationTarget } from "../core/contracts.js";

/**
 * Launching a browser is the most common thing to go wrong on a new machine: Playwright upgrades expect a browser
 * build that has not been downloaded yet. Instead of failing, TestSwarm tries, in order:
 *   1. an explicit executable (target.executablePath or TESTSWARM_BROWSER_PATH), and nothing else when one is set;
 *   2. the browser build this Playwright version expects;
 *   3. other Chromium builds already downloaded by Playwright (newest first);
 *   4. installed Google Chrome, then Microsoft Edge.
 * The first candidate that launches is remembered for the rest of the process.
 */
export interface BrowserCandidate { label: string; options: LaunchOptions; }

export class BrowserUnavailableError extends Error {
  override name = "BrowserUnavailableError";
  constructor(readonly attempts: Array<{ label: string; error: string }>, browserName: string) {
    super([
      `Could not start ${browserName}. Tried:`,
      ...attempts.map(item => `  - ${item.label}: ${item.error}`),
      `Fix: run "npx testswarm install-browser" (or "npx playwright install ${browserName}"), install Google Chrome, or set target.executablePath / TESTSWARM_BROWSER_PATH.`
    ].join("\n"));
  }
}

export function browserType(target: Pick<ApplicationTarget, "browser">): BrowserType {
  return target.browser === "firefox" ? firefox : target.browser === "webkit" ? webkit : chromium;
}

/** Playwright's browser cache directories on this machine. */
function playwrightCacheDirs() {
  const dirs = [process.env.PLAYWRIGHT_BROWSERS_PATH, join(homedir(), ".cache", "ms-playwright"), join(homedir(), "Library", "Caches", "ms-playwright"), process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "ms-playwright") : undefined];
  return [...new Set(dirs.filter((dir): dir is string => Boolean(dir) && dir !== "0" && existsSync(dir!)))];
}

const CHROMIUM_BINARIES = [
  ["chrome-linux64", "chrome"], ["chrome-linux", "chrome"], ["chrome-win64", "chrome.exe"], ["chrome-win", "chrome.exe"],
  ["chrome-mac-arm64", "Chromium.app/Contents/MacOS/Chromium"], ["chrome-mac", "Chromium.app/Contents/MacOS/Chromium"]
];

/** Chromium builds Playwright has downloaded, newest revision first. */
export function cachedChromiumBuilds(): string[] {
  const found: Array<{ revision: number; path: string }> = [];
  for (const dir of playwrightCacheDirs()) {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      const match = /^chromium-(\d+)$/.exec(entry);
      if (!match) continue;
      for (const [folder, binary] of CHROMIUM_BINARIES) {
        const path = join(dir, entry, folder, binary);
        if (existsSync(path)) { found.push({ revision: Number(match[1]), path }); break; }
      }
    }
  }
  return found.sort((a, b) => b.revision - a.revision).map(item => item.path);
}

export function launchCandidates(target: ApplicationTarget): BrowserCandidate[] {
  const headed = process.env.TESTSWARM_HEADED === "1" || target.headless === false;
  const base: LaunchOptions = { headless: !headed, ...(target.slowMoMs ? { slowMo: target.slowMoMs } : {}) };
  const explicit = target.executablePath ?? (process.env.TESTSWARM_BROWSER_PATH || undefined);
  if (explicit) return [{ label: `configured executable ${explicit}`, options: { ...base, executablePath: explicit } }];
  const candidates: BrowserCandidate[] = [{ label: `Playwright-managed ${target.browser}`, options: base }];
  if (target.browser === "chromium") {
    for (const path of cachedChromiumBuilds()) candidates.push({ label: `downloaded Chromium ${path}`, options: { ...base, executablePath: path } });
    candidates.push({ label: "installed Google Chrome", options: { ...base, channel: "chrome" } }, { label: "installed Microsoft Edge", options: { ...base, channel: "msedge" } });
  }
  return candidates;
}

const resolved = new Map<string, BrowserCandidate>();
const cacheKey = (target: ApplicationTarget) => JSON.stringify([target.browser, target.executablePath ?? process.env.TESTSWARM_BROWSER_PATH ?? "", target.headless, process.env.TESTSWARM_HEADED ?? "", target.slowMoMs ?? 0]);
const firstLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0].replace(/^browserType\.launch: /, "");

/** Launches the first browser candidate that works and remembers it for this process. */
export async function launchBrowser(target: ApplicationTarget): Promise<Browser> {
  const headed = process.env.TESTSWARM_HEADED === "1" || target.headless === false;
  if (headed && process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new BrowserUnavailableError([{ label: "headed browser", error: "no display is available (DISPLAY and WAYLAND_DISPLAY are unset). Run under xvfb-run, use a desktop session, or drop --headed / set target.headless to true" }], target.browser);
  }
  const key = cacheKey(target), known = resolved.get(key);
  if (known) {
    try { return await browserType(target).launch(known.options); }
    catch { resolved.delete(key); } // the remembered browser went away; search again
  }
  const attempts: Array<{ label: string; error: string }> = [];
  for (const candidate of launchCandidates(target)) {
    try {
      const browser = await browserType(target).launch(candidate.options);
      resolved.set(key, candidate);
      return browser;
    } catch (error) { attempts.push({ label: candidate.label, error: firstLine(error) }); }
  }
  throw new BrowserUnavailableError(attempts, target.browser);
}

/** Which candidate launched for this target in this process, if any. */
export function resolvedBrowser(target: ApplicationTarget) { return resolved.get(cacheKey(target))?.label; }

/** Runs Playwright's own installer for the browser this Playwright version expects. */
export function installBrowser(browserName: string, options: { withDeps?: boolean } = {}): Promise<number> {
  const cli = join(dirname(createRequire(import.meta.url).resolve("playwright/package.json")), "cli.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "install", ...(options.withDeps ? ["--with-deps"] : []), browserName], { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("exit", code => resolve(code ?? 1));
  });
}
