import "./quiet-warnings.js";
import { mkdirSync, chmodSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

// Loaded through require so the ExperimentalWarning filter in quiet-warnings.ts is installed first;
// a static import of a builtin is linked (and warns) before any module code runs.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
import { TestExecution, TestPlan, TestRun } from "./contracts.js";

export interface Store {
  putPlan(plan: TestPlan): Promise<void>;
  getPlan(id: string): Promise<TestPlan | undefined>;
  /** Writes run metadata (status, timestamps). Executions are appended separately with addExecution. */
  putRun(run: TestRun): Promise<void>;
  addExecution(runId: string, execution: TestExecution): Promise<void>;
  getRun(id: string): Promise<TestRun | undefined>;
  listRuns(limit?: number): Promise<TestRun[]>;
  requestCancel(runId: string, requested?: boolean): Promise<void>;
  isCancelRequested(runId: string): Promise<boolean>;
  /** Deletes all but the newest `keep` runs and returns the deleted run ids. */
  pruneRuns(keep: number): Promise<string[]>;
  close(): void;
}

// Each entry migrates the schema from version (index) to version (index + 1).
const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY (plan_id) REFERENCES plans(id));
   CREATE INDEX IF NOT EXISTS runs_plan_id ON runs(plan_id);`,
  // v2: executions get their own rows so a long run is not rewritten as one blob after every case,
  // and cancellation becomes a durable flag visible to every process sharing the database.
  `ALTER TABLE runs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE runs ADD COLUMN started_at TEXT;
   CREATE TABLE IF NOT EXISTS executions (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL, FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE);
   CREATE INDEX IF NOT EXISTS executions_run_id ON executions(run_id, seq);`
];

export class SqliteStore implements Store {
  private readonly db: DatabaseSyncType;
  constructor(readonly file = ".testswarm/testswarm.db") {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    try { chmodSync(file, 0o600); } catch { /* best effort on filesystems without POSIX modes */ }
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate() {
    const current = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    for (let version = current; version < MIGRATIONS.length; version++) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(MIGRATIONS[version]);
        if (version === 1) this.migrateEmbeddedExecutions();
        this.db.exec(`PRAGMA user_version = ${version + 1}`);
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
  }

  // v1 stored executions inside the run payload; move them into the executions table.
  private migrateEmbeddedExecutions() {
    const rows = this.db.prepare("SELECT id, payload FROM runs").all() as Array<{ id: string; payload: string }>;
    const insert = this.db.prepare("INSERT OR IGNORE INTO executions(id, run_id, seq, payload) VALUES(?,?,?,?)");
    const update = this.db.prepare("UPDATE runs SET payload=?, started_at=? WHERE id=?");
    for (const row of rows) {
      const run = JSON.parse(row.payload) as TestRun;
      (run.executions ?? []).forEach((execution, index) => insert.run(execution.id, row.id, index, JSON.stringify(execution)));
      update.run(JSON.stringify({ ...run, executions: [] }), run.startedAt ?? null, row.id);
    }
  }

  async putPlan(plan: TestPlan) {
    this.db.prepare("INSERT INTO plans(id,payload,created_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(plan.id, JSON.stringify(plan), plan.generatedAt);
  }

  async getPlan(id: string) {
    const row = this.db.prepare("SELECT payload FROM plans WHERE id=?").get(id) as { payload: string } | undefined;
    return row ? TestPlan.parse(JSON.parse(row.payload)) : undefined;
  }

  async putRun(run: TestRun) {
    const meta = { ...run, executions: [] };
    this.db.prepare("INSERT INTO runs(id,plan_id,status,payload,updated_at,started_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload,updated_at=excluded.updated_at")
      .run(run.id, run.planId, run.status, JSON.stringify(meta), new Date().toISOString(), run.startedAt);
  }

  async addExecution(runId: string, execution: TestExecution) {
    const next = (this.db.prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM executions WHERE run_id=?").get(runId) as { seq: number }).seq;
    this.db.prepare("INSERT INTO executions(id, run_id, seq, payload) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(execution.id, runId, next, JSON.stringify(execution));
    this.db.prepare("UPDATE runs SET updated_at=? WHERE id=?").run(new Date().toISOString(), runId);
  }

  async getRun(id: string) {
    const row = this.db.prepare("SELECT payload FROM runs WHERE id=?").get(id) as { payload: string } | undefined;
    if (!row) return undefined;
    const executions = (this.db.prepare("SELECT payload FROM executions WHERE run_id=? ORDER BY seq").all(id) as Array<{ payload: string }>).map(item => JSON.parse(item.payload));
    return TestRun.parse({ ...JSON.parse(row.payload), executions });
  }

  async listRuns(limit = 100) {
    const rows = this.db.prepare("SELECT id FROM runs ORDER BY COALESCE(started_at, updated_at) DESC LIMIT ?").all(limit) as Array<{ id: string }>;
    const runs: TestRun[] = [];
    for (const row of rows) { const run = await this.getRun(row.id); if (run) runs.push(run); }
    return runs;
  }

  async requestCancel(runId: string, requested = true) { this.db.prepare("UPDATE runs SET cancel_requested=? WHERE id=?").run(requested ? 1 : 0, runId); }

  async isCancelRequested(runId: string) {
    const row = this.db.prepare("SELECT cancel_requested FROM runs WHERE id=?").get(runId) as { cancel_requested: number } | undefined;
    return Boolean(row?.cancel_requested);
  }

  async pruneRuns(keep: number) {
    const rows = this.db.prepare("SELECT id FROM runs WHERE status NOT IN ('running','queued') ORDER BY COALESCE(started_at, updated_at) DESC LIMIT -1 OFFSET ?").all(keep) as Array<{ id: string }>;
    const remove = this.db.prepare("DELETE FROM runs WHERE id=?");
    for (const row of rows) remove.run(row.id);
    return rows.map(row => row.id);
  }

  close() { this.db.close(); }
}

/** File-backed store for tests and migration tooling. Not safe for concurrent processes. */
export class JsonStore implements Store {
  constructor(private readonly file: string) {}
  private async state(): Promise<{ plans: Record<string, TestPlan>; runs: Record<string, TestRun & { cancelRequested?: boolean }> }> {
    try { return JSON.parse(await readFile(this.file, "utf8")); } catch { return { plans: {}, runs: {} }; }
  }
  private async save(state: Awaited<ReturnType<JsonStore["state"]>>) { await mkdir(dirname(this.file), { recursive: true }); await writeFile(this.file, JSON.stringify(state, null, 2)); }
  async putPlan(plan: TestPlan) { const s = await this.state(); s.plans[plan.id] = plan; await this.save(s); }
  async getPlan(id: string) { return (await this.state()).plans[id]; }
  async putRun(run: TestRun) { const s = await this.state(); const existing = s.runs[run.id]; s.runs[run.id] = { ...run, executions: existing?.executions ?? [], cancelRequested: existing?.cancelRequested }; await this.save(s); }
  async addExecution(runId: string, execution: TestExecution) { const s = await this.state(); const run = s.runs[runId]; if (!run) throw new Error(`Run not found: ${runId}`); run.executions = [...run.executions.filter(item => item.id !== execution.id), execution]; await this.save(s); }
  async getRun(id: string) { const run = (await this.state()).runs[id]; if (!run) return undefined; const { cancelRequested: _, ...rest } = run; return rest; }
  async listRuns(limit = 100) { return Object.values((await this.state()).runs).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit).map(({ cancelRequested: _, ...rest }) => rest); }
  async requestCancel(runId: string, requested = true) { const s = await this.state(); if (s.runs[runId]) { s.runs[runId].cancelRequested = requested; await this.save(s); } }
  async isCancelRequested(runId: string) { return Boolean((await this.state()).runs[runId]?.cancelRequested); }
  async pruneRuns(keep: number) { const s = await this.state(); const old = Object.values(s.runs).filter(run => !["running", "queued"].includes(run.status)).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(keep); for (const run of old) delete s.runs[run.id]; await this.save(s); return old.map(run => run.id); }
  close() { /* nothing to release */ }
}
