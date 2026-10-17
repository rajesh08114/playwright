// node:sqlite is stable enough for this tool's use but still emits an ExperimentalWarning on every
// process start, which corrupts machine-readable CLI output. Drop only that warning.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const message = typeof warning === "string" ? warning : warning?.message;
  const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type ?? (warning as Error)?.name;
  if (type === "ExperimentalWarning" && /SQLite/i.test(message ?? "")) return;
  return (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
