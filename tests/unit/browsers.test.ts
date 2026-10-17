import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationTarget } from "../../src/core/contracts.js";
import { cachedChromiumBuilds, launchBrowser, launchCandidates } from "../../src/browser-runtime/browsers.js";

const target = (extra: Record<string, unknown> = {}) => ApplicationTarget.parse({ baseUrl: "http://127.0.0.1:3000", allowedOrigins: ["http://127.0.0.1:3000"], startPath: "/", ...extra });

async function withEnv(values: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) value === undefined ? delete process.env[key] : process.env[key] = value;
  try { await fn(); } finally { for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value; }
}

test("downloaded Chromium builds are found newest first", async () => {
  const cache = await mkdtemp(join(tmpdir(), "pw-cache-"));
  for (const [revision, folder, binary] of [["1100", "chrome-linux", "chrome"], ["1200", "chrome-win64", "chrome.exe"], ["900", "chrome-mac", "Chromium.app/Contents/MacOS/Chromium"]]) {
    const path = join(cache, `chromium-${revision}`, folder, binary);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "");
  }
  await mkdir(join(cache, "chromium_headless_shell-1300"), { recursive: true });
  await withEnv({ PLAYWRIGHT_BROWSERS_PATH: cache, HOME: cache, LOCALAPPDATA: undefined }, () => {
    const builds = cachedChromiumBuilds().filter(path => path.startsWith(cache));
    assert.deepEqual(builds.map(path => /chromium-(\d+)/.exec(path)?.[1]), ["1200", "1100", "900"]);
  });
});

test("an explicit executable is the only candidate; otherwise managed, cached builds, Chrome, then Edge", async () => {
  await withEnv({ TESTSWARM_BROWSER_PATH: undefined, TESTSWARM_HEADED: undefined }, () => {
    assert.deepEqual(launchCandidates(target({ executablePath: "/opt/chrome" })).map(item => item.label), ["configured executable /opt/chrome"]);
    const labels = launchCandidates(target()).map(item => item.label);
    assert.equal(labels[0], "Playwright-managed chromium");
    assert.deepEqual(labels.slice(-2), ["installed Google Chrome", "installed Microsoft Edge"]);
    assert.deepEqual(launchCandidates(target({ browser: "firefox" })).map(item => item.label), ["Playwright-managed firefox"]);
  });
  await withEnv({ TESTSWARM_BROWSER_PATH: "/env/chrome" }, () => {
    assert.equal(launchCandidates(target())[0].options.executablePath, "/env/chrome");
  });
});

test("headed mode and slow motion come from config or TESTSWARM_HEADED", async () => {
  await withEnv({ TESTSWARM_HEADED: undefined }, () => {
    assert.equal(launchCandidates(target())[0].options.headless, true);
    const headed = launchCandidates(target({ headless: false, slowMoMs: 250 }))[0].options;
    assert.equal(headed.headless, false);
    assert.equal(headed.slowMo, 250);
  });
  await withEnv({ TESTSWARM_HEADED: "1" }, () => assert.equal(launchCandidates(target())[0].options.headless, false));
});

test("headed mode without a display fails with a clear reason instead of a browser crash", { skip: process.platform !== "linux" }, async () => {
  await withEnv({ TESTSWARM_HEADED: "1", DISPLAY: undefined, WAYLAND_DISPLAY: undefined }, async () => {
    await assert.rejects(() => launchBrowser(target()), /no display is available.*xvfb-run/);
  });
});
