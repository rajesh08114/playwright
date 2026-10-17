import type { Locator as PwLocator, Page } from "playwright";
import type { Action, Locator } from "../core/contracts.js";

/** A step needs a secret from an environment variable that is not set. The case is blocked, not failed. */
export class MissingSecretError extends Error { override name = "MissingSecretError"; }
/** A journey step failed. `step` is 1-based. */
export class StepError extends Error {
  override name = "StepError";
  constructor(readonly step: number, readonly description: string, cause: string) { super(`Step ${step} (${description}) failed: ${cause}`); }
}

export function describeLocator(locator: Locator): string {
  if ("role" in locator) return `${locator.role}${locator.name ? ` "${locator.name}"` : ""}`;
  if ("label" in locator) return `label "${locator.label}"`;
  if ("text" in locator) return `text "${locator.text}"`;
  if ("placeholder" in locator) return `placeholder "${locator.placeholder}"`;
  if ("testId" in locator) return `test id "${locator.testId}"`;
  return `css ${locator.css}`;
}

/** Human-readable step description. Never contains secret values. */
export function describeAction(step: Action): string {
  switch (step.type) {
    case "goto": return `go to ${step.path}`;
    case "click": return `click ${describeLocator(step.target)}`;
    case "fill": return `fill ${describeLocator(step.target)} with ${step.valueFromEnv ? `$${step.valueFromEnv}` : JSON.stringify(step.value)}`;
    case "select": return `select ${JSON.stringify(step.value)} in ${describeLocator(step.target)}`;
    case "check": return `${step.checked === false ? "uncheck" : "check"} ${describeLocator(step.target)}`;
    case "press": return `press ${step.key}${step.target ? ` in ${describeLocator(step.target)}` : ""}`;
    case "waitFor": return `wait for ${describeLocator(step.target)} to be ${step.state ?? "visible"}`;
    case "expectVisible": return `expect ${describeLocator(step.target)} visible`;
    case "expectHidden": return `expect ${describeLocator(step.target)} hidden`;
    case "expectText": return `expect ${describeLocator(step.target)} to contain ${JSON.stringify(step.text)}`;
    case "expectUrl": return `expect URL to contain ${step.path}`;
    case "expectTitle": return `expect title to contain ${JSON.stringify(step.text)}`;
  }
}

export const usesSecrets = (steps: Action[] = []) => steps.some(step => step.type === "fill" && Boolean(step.valueFromEnv));

export function resolveLocator(page: Page, locator: Locator): PwLocator {
  if ("role" in locator) return page.getByRole(locator.role as Parameters<Page["getByRole"]>[0], { name: locator.name, exact: locator.exact });
  if ("label" in locator) return page.getByLabel(locator.label, { exact: locator.exact });
  if ("text" in locator) return page.getByText(locator.text, { exact: locator.exact });
  if ("placeholder" in locator) return page.getByPlaceholder(locator.placeholder);
  if ("testId" in locator) return page.getByTestId(locator.testId);
  return page.locator(locator.css);
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number, failure: () => Promise<string>) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() >= deadline) throw new Error(await failure());
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

export interface ActionContext {
  baseUrl: string;
  allowedOrigins: Set<string>;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

/** Executes journey steps in order. Throws StepError on the first failing step, MissingSecretError if a secret is unset. */
export async function runActions(page: Page, steps: Action[], context: ActionContext) {
  const env = context.env ?? process.env;
  for (const secret of steps.flatMap(step => step.type === "fill" && step.valueFromEnv ? [step.valueFromEnv] : [])) {
    if (!env[secret]) throw new MissingSecretError(`Environment variable ${secret} is not set`);
  }
  for (const [index, step] of steps.entries()) {
    const description = describeAction(step);
    try { await runAction(page, step, context, env); }
    catch (error) {
      if (error instanceof MissingSecretError) throw error;
      throw new StepError(index + 1, description, (error instanceof Error ? error.message : String(error)).split("\n")[0]);
    }
  }
}

async function runAction(page: Page, step: Action, context: ActionContext, env: NodeJS.ProcessEnv) {
  const timeout = context.timeoutMs;
  switch (step.type) {
    case "goto": {
      const url = new URL(step.path, context.baseUrl);
      if (!context.allowedOrigins.has(url.origin)) throw new Error(`${url.origin} is outside target.allowedOrigins`);
      const response = await page.goto(url.href, { waitUntil: "load" });
      if (response && response.status() >= 400) throw new Error(`HTTP ${response.status()}`);
      return;
    }
    case "click": return resolveLocator(page, step.target).click({ timeout });
    case "fill": return resolveLocator(page, step.target).fill(step.valueFromEnv ? env[step.valueFromEnv]! : step.value!, { timeout });
    case "select": { await resolveLocator(page, step.target).selectOption(step.value, { timeout }); return; }
    case "check": return resolveLocator(page, step.target).setChecked(step.checked ?? true, { timeout });
    case "press": return step.target ? resolveLocator(page, step.target).press(step.key, { timeout }) : page.keyboard.press(step.key);
    case "waitFor": return resolveLocator(page, step.target).waitFor({ state: step.state ?? "visible", timeout });
    case "expectVisible": return resolveLocator(page, step.target).waitFor({ state: "visible", timeout });
    case "expectHidden": return resolveLocator(page, step.target).waitFor({ state: "hidden", timeout });
    case "expectText": {
      const locator = resolveLocator(page, step.target);
      return waitUntil(async () => (await locator.innerText({ timeout: 500 })).includes(step.text), timeout, async () => `text was ${JSON.stringify((await locator.innerText({ timeout: 500 }).catch(() => "<not found>")).slice(0, 200))}`);
    }
    case "expectUrl":
      return waitUntil(async () => { const url = new URL(page.url()); return `${url.pathname}${url.search}${url.hash}`.includes(step.path); }, timeout, async () => `URL was ${new URL(page.url()).pathname}`);
    case "expectTitle":
      return waitUntil(async () => (await page.title()).includes(step.text), timeout, async () => `title was ${JSON.stringify(await page.title())}`);
  }
}
