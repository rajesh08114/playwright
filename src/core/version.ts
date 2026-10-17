import { readFileSync } from "node:fs";

// dist/src/core/version.js -> package.json at the package root.
export const VERSION: string = (() => {
  try { return JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version; } catch { return "0.0.0"; }
})();
