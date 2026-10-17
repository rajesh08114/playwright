import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { ProjectConfiguration } from "./contracts.js";

export const DEFAULT_CONFIG_FILE = "testswarm.config.json";

// Hosts that must never be reachable from a test run: unspecified addresses and cloud metadata endpoints.
const FORBIDDEN_HOSTS = new Set(["0.0.0.0", "[::]", "::", "169.254.169.254", "[fd00:ec2::254]", "metadata.google.internal", "metadata.azure.internal", "100.100.100.200"]);

export interface ProjectLocation { root: string; configPath: string; }

/** Resolves the project directory and config file from explicit options, environment variables, or the working directory. */
export function locateProject(options: { projectDir?: string; configPath?: string } = {}): ProjectLocation {
  const root = resolve(options.projectDir ?? process.env.TESTSWARM_PROJECT_DIR ?? process.cwd());
  const configPath = resolve(root, options.configPath ?? process.env.TESTSWARM_CONFIG ?? DEFAULT_CONFIG_FILE);
  return { root, configPath };
}

/**
 * Loads and validates a project configuration. All filesystem paths in the result are absolute,
 * resolved against the project root (the directory containing the config file by default).
 */
export async function loadConfig(path?: string, root?: string): Promise<ProjectConfiguration> {
  const location = path ? { root: resolve(root ?? process.env.TESTSWARM_PROJECT_DIR ?? process.cwd()), configPath: resolve(root ?? process.cwd(), path) } : locateProject({ projectDir: root });
  let text: string;
  try { text = await readFile(location.configPath, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ConfigError(`Configuration not found at ${location.configPath}. Run "testswarm init" or set TESTSWARM_PROJECT_DIR / TESTSWARM_CONFIG.`);
    throw error;
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (error) { throw new ConfigError(`Configuration ${location.configPath} is not valid JSON: ${(error as Error).message}`); }
  const parsed = ProjectConfiguration.safeParse(raw);
  if (!parsed.success) throw new ConfigError(`Invalid configuration: ${parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const config = parsed.data;
  const base = new URL(config.target.baseUrl);
  const origins = config.target.allowedOrigins.map(x => new URL(x).origin);
  if (!origins.includes(base.origin)) throw new ConfigError("target.baseUrl must belong to allowedOrigins");
  if (origins.some(origin => FORBIDDEN_HOSTS.has(new URL(origin).hostname))) throw new ConfigError("Wildcard, metadata, and unspecified network origins are not permitted");
  if (config.testData && !origins.includes(new URL(config.testData.setupUrl).origin)) throw new ConfigError("testData.setupUrl must belong to allowedOrigins");
  if (config.testData?.cleanupUrl && !origins.includes(new URL(config.testData.cleanupUrl).origin)) throw new ConfigError("testData.cleanupUrl must belong to allowedOrigins");

  const abs = (value: string) => isAbsolute(value) ? value : resolve(location.root, value);
  config.artifactsDir = abs(config.artifactsDir);
  config.target.allowedOrigins = origins;
  config.target.visualBaselinesDir = config.target.visualBaselinesDir ? abs(config.target.visualBaselinesDir) : resolve(config.artifactsDir, "visual-baselines");
  if (config.target.storageStatePath) config.target.storageStatePath = abs(config.target.storageStatePath);
  config.target.executablePath ??= process.env.TESTSWARM_BROWSER_PATH || undefined;
  if (config.target.executablePath) config.target.executablePath = abs(config.target.executablePath);
  if (config.testData?.fixturePath) config.testData.fixturePath = abs(config.testData.fixturePath);
  if (config.benchmarkOraclePath) config.benchmarkOraclePath = abs(config.benchmarkOraclePath);
  return config;
}

/** A user-correctable configuration problem (as opposed to a test failure or an internal error). */
export class ConfigError extends Error { override name = "ConfigError"; }

export function starterConfig(baseUrl = "http://127.0.0.1:3000") {
  const origin = new URL(baseUrl).origin;
  return {
    schemaVersion: 1,
    name: "local-app",
    artifactsDir: ".testswarm",
    target: {
      baseUrl: origin,
      allowedOrigins: [origin],
      startPath: "/",
      routes: [],
      browser: "chromium",
      actionTimeoutMs: 10000,
      navigationTimeoutMs: 30000,
      viewport: { width: 1280, height: 720 },
      viewportProfiles: [
        { name: "mobile", width: 390, height: 844 },
        { name: "desktop", width: 1280, height: 720 }
      ]
    },
    budgets: { maxRoutes: 25, maxCases: 200, maxRetries: 1, maxConcurrency: 2 },
    policy: { accessibilityFailOn: "serious", failOnConsoleErrors: true, visualMaxDiffRatio: 0.001, trace: "retain-on-failure", retainRuns: 50 }
  };
}
