import { mkdir } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TestPlan, TestRun } from "./contracts.js";

export interface Store {
  putPlan(plan: TestPlan): Promise<void>;
  getPlan(id: string): Promise<TestPlan | undefined>;
  putRun(run: TestRun): Promise<void>;
  getRun(id: string): Promise<TestRun | undefined>;
  listRuns(): Promise<TestRun[]>;
}

export class SqliteStore implements Store {
  private readonly db: DatabaseSync;
  constructor(file = ".testswarm/testswarm.db") {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY (plan_id) REFERENCES plans(id)); CREATE INDEX IF NOT EXISTS runs_status_idx ON runs(status);");
  }
  async putPlan(plan: TestPlan) { this.db.prepare("INSERT INTO plans(id,payload,created_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(plan.id, JSON.stringify(plan), plan.generatedAt); }
  async getPlan(id: string) { const row = this.db.prepare("SELECT payload FROM plans WHERE id=?").get(id) as { payload: string } | undefined; return row ? TestPlan.parse(JSON.parse(row.payload)) : undefined; }
  async putRun(run: TestRun) { this.db.prepare("INSERT INTO runs(id,plan_id,status,payload,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload,updated_at=excluded.updated_at").run(run.id, run.planId, run.status, JSON.stringify(run), new Date().toISOString()); }
  async getRun(id: string) { const row = this.db.prepare("SELECT payload FROM runs WHERE id=?").get(id) as { payload: string } | undefined; return row ? TestRun.parse(JSON.parse(row.payload)) : undefined; }
  async listRuns() { const rows = this.db.prepare("SELECT payload FROM runs ORDER BY updated_at DESC").all() as Array<{ payload: string }>; return rows.map(row => TestRun.parse(JSON.parse(row.payload))); }
  close() { this.db.close(); }
}

export class JsonStore implements Store {
  constructor(private readonly file: string) {}
  private async state(): Promise<{ plans: Record<string, TestPlan>; runs: Record<string, TestRun> }> { try { return JSON.parse(await (await import("node:fs/promises")).readFile(this.file, "utf8")); } catch { return { plans: {}, runs: {} }; } }
  private async save(state: { plans: Record<string, TestPlan>; runs: Record<string, TestRun> }) { const fs = await import("node:fs/promises"); await mkdir(dirname(this.file), { recursive: true }); await fs.writeFile(this.file, JSON.stringify(state, null, 2)); }
  async putPlan(plan: TestPlan) { const s = await this.state(); s.plans[plan.id] = plan; await this.save(s); }
  async getPlan(id: string) { return (await this.state()).plans[id]; }
  async putRun(run: TestRun) { const s = await this.state(); s.runs[run.id] = run; await this.save(s); }
  async getRun(id: string) { return (await this.state()).runs[id]; }
  async listRuns() { return Object.values((await this.state()).runs); }
}
