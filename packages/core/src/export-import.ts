import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { SCHEMA_VERSION, type ReplayEvent, type RunRecord } from "./events.js";
import type { AssertionSpec, FixtureRecord, ReplayStore } from "./storage.js";

export interface TraceExport {
  schemaVersion: string;
  exportedAt: string;
  integrity: string;
  projectId: string;
  runs: Array<{
    run: RunRecord;
    events: ReplayEvent[];
  }>;
  fixtures?: FixtureRecord[];
}

function computeIntegrity(payload: Omit<TraceExport, "integrity">): string {
  const canonical = JSON.stringify(payload);
  return createHash("sha256").update(canonical).digest("hex");
}

export function exportProject(
  store: ReplayStore,
  projectId: string,
  opts?: { includeFixtures?: boolean },
): TraceExport {
  const runs = store.listRuns(projectId).map((run) => ({
    run,
    events: store.getEvents(run.runId),
  }));
  const fixtures = opts?.includeFixtures ? store.listFixtures(projectId) : undefined;

  const withoutIntegrity: Omit<TraceExport, "integrity"> = {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    projectId,
    runs,
    fixtures,
  };

  return {
    ...withoutIntegrity,
    integrity: computeIntegrity(withoutIntegrity),
  };
}

export function writeExport(path: string, data: TraceExport): void {
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

export function readExport(path: string): TraceExport {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as TraceExport;
}

export interface ImportResult {
  ok: boolean;
  runsImported: number;
  fixturesImported: number;
  errors: string[];
}

/**
 * Import a portable JSON export. Verifies schema version + integrity.
 * Traces are untrusted — never execute payload content.
 */
export function importProject(
  store: ReplayStore,
  data: TraceExport,
  opts?: {
    skipIntegrity?: boolean;
    /**
     * Remap imported runs/fixtures into this project id (default: export's projectId).
     * CLI passes the local config project so `list` / `test` work after import.
     */
    targetProjectId?: string;
  },
): ImportResult {
  const errors: string[] = [];

  if (!data || typeof data !== "object") {
    return { ok: false, runsImported: 0, fixturesImported: 0, errors: ["Invalid export object"] };
  }
  if (data.schemaVersion !== SCHEMA_VERSION) {
    errors.push(
      `Schema version mismatch: expected ${SCHEMA_VERSION}, got ${String(data.schemaVersion)}`,
    );
  }

  if (!opts?.skipIntegrity) {
    const { integrity: _i, ...rest } = data;
    const expected = computeIntegrity(rest);
    if (data.integrity !== expected) {
      errors.push("Integrity check failed: export hash does not match contents");
    }
  }

  if (errors.length > 0) {
    return { ok: false, runsImported: 0, fixturesImported: 0, errors };
  }

  const projectId = opts?.targetProjectId ?? data.projectId;
  store.ensureProject(projectId, projectId);

  let runsImported = 0;
  for (const entry of data.runs ?? []) {
    const existing = store.getRun(entry.run.runId);
    if (existing) {
      errors.push(`Skip existing run ${entry.run.runId}`);
      continue;
    }
    const run = { ...entry.run, projectId };
    store.insertRun(run);
    for (const ev of entry.events) {
      store.insertEvent(ev);
    }
    runsImported++;
  }

  let fixturesImported = 0;
  for (const fx of data.fixtures ?? []) {
    store.saveFixture({ ...fx, projectId });
    fixturesImported++;
  }

  return {
    ok: errors.length === 0,
    runsImported,
    fixturesImported,
    errors,
  };
}

/** Load events from a JSON export file for a specific run (CI-friendly, no DB required). */
export function loadRunFromExport(
  data: TraceExport,
  runId: string,
): { run: RunRecord; events: ReplayEvent[] } | undefined {
  const entry = data.runs.find((r) => r.run.runId === runId);
  if (!entry) return undefined;
  return { run: entry.run, events: entry.events };
}

export function loadFixtureFromExport(data: TraceExport, name: string): FixtureRecord | undefined {
  return data.fixtures?.find((f) => f.name === name);
}

export type { AssertionSpec };
