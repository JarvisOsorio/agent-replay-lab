import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type ReplayEvent, type RunRecord, SCHEMA_VERSION } from "./events.js";

export interface FixtureRecord {
  fixtureId: string;
  projectId: string;
  name: string;
  sourceRunId: string;
  createdAt: string;
  assertions: AssertionSpec[];
  metadata?: Record<string, unknown>;
}

export type AssertionSpec =
  | { type: "tool.called"; toolName: string; count?: number }
  | { type: "tool.notCalled"; toolName: string }
  | { type: "tool.argsMatch"; toolName: string; args: Record<string, unknown>; occurrence?: number }
  | { type: "tool.responseMatch"; toolName: string; result: unknown; occurrence?: number }
  | { type: "noUnexpectedTools"; allowed: string[] }
  | { type: "sequence"; toolNames: string[] }
  | { type: "run.status"; status: "completed" | "failed" };

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    root_path TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    status TEXT NOT NULL,
    label TEXT,
    metadata_json TEXT,
    FOREIGN KEY (project_id) REFERENCES projects(project_id)
  );`,
  `CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    type TEXT NOT NULL,
    parent_event_id TEXT,
    span_id TEXT,
    source_json TEXT,
    payload_json TEXT NOT NULL,
    metadata_json TEXT,
    UNIQUE (run_id, sequence),
    FOREIGN KEY (run_id) REFERENCES runs(run_id)
  );`,
  `CREATE TABLE IF NOT EXISTS fixtures (
    fixture_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    source_run_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    assertions_json TEXT NOT NULL,
    metadata_json TEXT,
    UNIQUE (project_id, name),
    FOREIGN KEY (project_id) REFERENCES projects(project_id)
  );`,
];

export class ReplayStore {
  readonly dbPath: string;
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    for (const sql of MIGRATIONS) {
      this.db.exec(sql);
    }
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get("schema_version") as
      { value: string } | undefined;
    if (!row) {
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES (?, ?)")
        .run("schema_version", SCHEMA_VERSION);
    }
  }

  close(): void {
    this.db.close();
  }

  getSchemaVersion(): string {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get("schema_version") as
      { value: string } | undefined;
    return row?.value ?? SCHEMA_VERSION;
  }

  ensureProject(projectId: string, name: string, rootPath?: string): void {
    const existing = this.db
      .prepare("SELECT project_id FROM projects WHERE project_id = ?")
      .get(projectId);
    if (existing) return;
    this.db
      .prepare("INSERT INTO projects (project_id, name, created_at, root_path) VALUES (?, ?, ?, ?)")
      .run(projectId, name, new Date().toISOString(), rootPath ?? null);
  }

  insertRun(run: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (run_id, project_id, started_at, completed_at, status, label, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.runId,
        run.projectId,
        run.startedAt,
        run.completedAt ?? null,
        run.status,
        run.label ?? null,
        run.metadata ? JSON.stringify(run.metadata) : null,
      );
  }

  updateRun(
    runId: string,
    patch: Partial<Pick<RunRecord, "completedAt" | "status" | "label" | "metadata">>,
  ): void {
    const current = this.getRun(runId);
    if (!current) throw new Error(`Run not found: ${runId}`);
    this.db
      .prepare(
        `UPDATE runs SET completed_at = ?, status = ?, label = ?, metadata_json = ? WHERE run_id = ?`,
      )
      .run(
        patch.completedAt ?? current.completedAt ?? null,
        patch.status ?? current.status,
        patch.label ?? current.label ?? null,
        JSON.stringify(patch.metadata ?? current.metadata ?? null),
        runId,
      );
  }

  getRun(runId: string): RunRecord | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as
      | {
          run_id: string;
          project_id: string;
          started_at: string;
          completed_at: string | null;
          status: string;
          label: string | null;
          metadata_json: string | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      runId: row.run_id,
      projectId: row.project_id,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
      status: row.status as RunRecord["status"],
      label: row.label ?? undefined,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
    };
  }

  listRuns(projectId?: string): RunRecord[] {
    const rows = (
      projectId
        ? this.db
            .prepare("SELECT * FROM runs WHERE project_id = ? ORDER BY started_at DESC")
            .all(projectId)
        : this.db.prepare("SELECT * FROM runs ORDER BY started_at DESC").all()
    ) as Array<{
      run_id: string;
      project_id: string;
      started_at: string;
      completed_at: string | null;
      status: string;
      label: string | null;
      metadata_json: string | null;
    }>;
    return rows.map((row) => ({
      runId: row.run_id,
      projectId: row.project_id,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
      status: row.status as RunRecord["status"],
      label: row.label ?? undefined,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
    }));
  }

  insertEvent(event: ReplayEvent): void {
    this.db
      .prepare(
        `INSERT INTO events (
          event_id, run_id, sequence, timestamp, type, parent_event_id, span_id,
          source_json, payload_json, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.eventId,
        event.runId,
        event.sequence,
        event.timestamp,
        event.type,
        event.parentEventId ?? null,
        event.spanId ?? null,
        event.source ? JSON.stringify(event.source) : null,
        JSON.stringify(event.payload),
        event.metadata ? JSON.stringify(event.metadata) : null,
      );
  }

  getEvents(runId: string): ReplayEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE run_id = ? ORDER BY sequence ASC")
      .all(runId) as Array<{
      event_id: string;
      run_id: string;
      sequence: number;
      timestamp: string;
      type: string;
      parent_event_id: string | null;
      span_id: string | null;
      source_json: string | null;
      payload_json: string;
      metadata_json: string | null;
    }>;
    return rows.map((row) => ({
      eventId: row.event_id,
      runId: row.run_id,
      sequence: row.sequence,
      timestamp: row.timestamp,
      type: row.type as ReplayEvent["type"],
      parentEventId: row.parent_event_id ?? undefined,
      spanId: row.span_id ?? undefined,
      source: row.source_json ? JSON.parse(row.source_json) : undefined,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
    }));
  }

  saveFixture(fixture: FixtureRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO fixtures (
          fixture_id, project_id, name, source_run_id, created_at, assertions_json, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fixture.fixtureId,
        fixture.projectId,
        fixture.name,
        fixture.sourceRunId,
        fixture.createdAt,
        JSON.stringify(fixture.assertions),
        fixture.metadata ? JSON.stringify(fixture.metadata) : null,
      );
  }

  getFixture(projectId: string, name: string): FixtureRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM fixtures WHERE project_id = ? AND name = ?")
      .get(projectId, name) as
      | {
          fixture_id: string;
          project_id: string;
          name: string;
          source_run_id: string;
          created_at: string;
          assertions_json: string;
          metadata_json: string | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      fixtureId: row.fixture_id,
      projectId: row.project_id,
      name: row.name,
      sourceRunId: row.source_run_id,
      createdAt: row.created_at,
      assertions: JSON.parse(row.assertions_json) as AssertionSpec[],
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
    };
  }

  getFixtureById(fixtureId: string): FixtureRecord | undefined {
    const row = this.db.prepare("SELECT * FROM fixtures WHERE fixture_id = ?").get(fixtureId) as
      | {
          fixture_id: string;
          project_id: string;
          name: string;
          source_run_id: string;
          created_at: string;
          assertions_json: string;
          metadata_json: string | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      fixtureId: row.fixture_id,
      projectId: row.project_id,
      name: row.name,
      sourceRunId: row.source_run_id,
      createdAt: row.created_at,
      assertions: JSON.parse(row.assertions_json) as AssertionSpec[],
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
    };
  }

  listFixtures(projectId?: string): FixtureRecord[] {
    const rows = (
      projectId
        ? this.db
            .prepare("SELECT * FROM fixtures WHERE project_id = ? ORDER BY created_at DESC")
            .all(projectId)
        : this.db.prepare("SELECT * FROM fixtures ORDER BY created_at DESC").all()
    ) as Array<{
      fixture_id: string;
      project_id: string;
      name: string;
      source_run_id: string;
      created_at: string;
      assertions_json: string;
      metadata_json: string | null;
    }>;
    return rows.map((row) => ({
      fixtureId: row.fixture_id,
      projectId: row.project_id,
      name: row.name,
      sourceRunId: row.source_run_id,
      createdAt: row.created_at,
      assertions: JSON.parse(row.assertions_json) as AssertionSpec[],
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
    }));
  }
}

export function defaultDbPath(cwd: string = process.cwd()): string {
  return `${cwd}/.agent-replay/store.sqlite`;
}
