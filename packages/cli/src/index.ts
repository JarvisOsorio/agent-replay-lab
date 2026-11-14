#!/usr/bin/env node
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ExitCode,
  OfflineMockReplay,
  ReplayStore,
  SCHEMA_VERSION,
  createEventId,
  defaultAssertionsFromEvents,
  exportProject,
  extractToolCalls,
  importProject,
  readExport,
  runFixtureAssertions,
  structuralDiff,
  writeExport,
  type FixtureRecord,
} from "@agent-replay-lab/core";
import { defaultConfig, loadConfig, requireConfig, resolveDbPath, saveConfig } from "./config.js";
import { emit, getFlag, hasFlag, parseFormat, stripFlags } from "./output.js";

const VERSION = "0.1.0";

function usage(): string {
  return `agent-replay ${VERSION} — VCR for tool-using TypeScript agents

Usage:
  agent-replay init [name]          Initialize local project (.agent-replay/)
  agent-replay list                 List recorded runs
  agent-replay inspect <runId>      Inspect a run's events
  agent-replay replay <runId>       Offline mock-replay tool calls (fail closed)
  agent-replay diff <runA> <runB>   Structural diff of two runs
  agent-replay test <fixture>       Run fixture assertions (CI exit codes)
  agent-replay export [path]        Export project traces to JSON
  agent-replay import <path>        Import JSON export into local store
  agent-replay doctor               Check local project health
  agent-replay fixture create <runId> <name>   Save assertions fixture from a run

Options:
  --json | --format json|human      Output format
  --project-id <id>                 Override project id (test/export)
  --db <path>                       Override SQLite path
  --cassette <path>                 JSON export for offline test (no DB)
  --run <runId>                     Candidate run for fixture test
  --help, -h                        Show help
  --version, -v                     Show version

Modes (honest):
  offline/mock replay stubs tools from the cassette. It does NOT re-run a live model.
  Structural diff compares tool name/order/args/response only.

Exit codes (test):
  0 pass · 1 assertion fail · 2 invalid fixture · 3 infra error
`;
}

function openStore(cwd: string, argv: string[]): { store: ReplayStore; projectId: string } {
  const cfg = requireConfig(cwd);
  const dbOverride = getFlag(argv, "db");
  const dbPath = dbOverride ?? resolveDbPath(cfg, cwd);
  const projectId = getFlag(argv, "project-id") ?? cfg.projectId;
  const store = new ReplayStore(dbPath);
  store.ensureProject(projectId, cfg.name, cwd);
  return { store, projectId };
}

async function cmdInit(argv: string[], cwd: string): Promise<number> {
  const format = parseFormat(argv);
  const args = stripFlags(argv);
  const name = args[0] ?? "agent-replay-project";
  if (loadConfig(cwd)) {
    emit(format, "Project already initialized.", {
      ok: false,
      error: "already_initialized",
      config: loadConfig(cwd),
    });
    return ExitCode.INFRA_ERROR;
  }
  const cfg = defaultConfig(name, cwd);
  saveConfig(cfg, cwd);
  const store = new ReplayStore(resolveDbPath(cfg, cwd));
  store.ensureProject(cfg.projectId, cfg.name, cwd);
  store.close();
  mkdirSync(join(cwd, ".agent-replay", "fixtures"), { recursive: true });
  writeFileSync(
    join(cwd, ".agent-replay", "README.md"),
    `# Agent Replay Lab local store

Schema ${SCHEMA_VERSION}. Local-first — no upload.

- \`store.sqlite\` — runs & events
- \`fixtures/\` — optional JSON fixtures for CI
- Offline mock replay fails closed if a mock is missing.
`,
    "utf8",
  );
  emit(
    format,
    `Initialized Agent Replay Lab project "${cfg.name}" (${cfg.projectId})\nDB: ${cfg.dbPath}`,
    { ok: true, config: cfg },
  );
  return ExitCode.PASS;
}

async function cmdList(argv: string[], cwd: string): Promise<number> {
  const format = parseFormat(argv);
  const { store, projectId } = openStore(cwd, argv);
  try {
    const runs = store.listRuns(projectId);
    if (format === "json") {
      emit(format, "", { ok: true, projectId, runs });
    } else {
      if (runs.length === 0) {
        process.stdout.write("No runs recorded yet.\n");
      } else {
        process.stdout.write(`Runs (${runs.length}):\n`);
        for (const r of runs) {
          process.stdout.write(
            `  ${r.runId}  ${r.status.padEnd(10)}  ${r.startedAt}  ${r.label ?? ""}\n`,
          );
        }
      }
    }
    return ExitCode.PASS;
  } finally {
    store.close();
  }
}

async function cmdInspect(argv: string[], cwd: string): Promise<number> {
  const format = parseFormat(argv);
  const args = stripFlags(argv);
  const runId = args[0];
  if (!runId) {
    emit(format, "Usage: agent-replay inspect <runId>", { ok: false, error: "missing_run_id" });
    return ExitCode.INFRA_ERROR;
  }
  const { store } = openStore(cwd, argv);
  try {
    const run = store.getRun(runId);
    if (!run) {
      emit(format, `Run not found: ${runId}`, { ok: false, error: "not_found", runId });
      return ExitCode.INFRA_ERROR;
    }
    const events = store.getEvents(runId);
    emit(
      format,
      [
        `Run ${run.runId}`,
        `  status: ${run.status}`,
        `  started: ${run.startedAt}`,
        `  completed: ${run.completedAt ?? "-"}`,
        `  label: ${run.label ?? "-"}`,
        `  events: ${events.length}`,
        ...events.map(
          (e) =>
            `  [${e.sequence}] ${e.type} ${e.type.startsWith("tool.") ? String(e.payload.toolName ?? "") : ""}`,
        ),
      ].join("\n"),
      { ok: true, run, events },
    );
    return ExitCode.PASS;
  } finally {
    store.close();
  }
}

async function cmdReplay(argv: string[], cwd: string): Promise<number> {
  const format = parseFormat(argv);
  const args = stripFlags(argv);
  const runId = args[0];
  if (!runId) {
    emit(format, "Usage: agent-replay replay <runId>", { ok: false, error: "missing_run_id" });
    return ExitCode.INFRA_ERROR;
  }
  const { store } = openStore(cwd, argv);
  try {
    const events = store.getEvents(runId);
    if (events.length === 0) {
      emit(format, `No events for run ${runId}`, { ok: false, error: "empty_run" });
      return ExitCode.INFRA_ERROR;
    }
    const calls = extractToolCalls(events);
    const mock = new OfflineMockReplay({ cassette: events, mode: "offline" });
    const result = await mock.runCalls(calls);
    const human = result.ok
      ? `Offline mock replay OK (${result.calls.length} tool calls)\nMode: offline — tools stubbed from cassette; model was NOT re-executed.`
      : `Offline mock replay FAILED\n${result.errors.map((e) => `  - ${e}`).join("\n")}`;
    emit(format, human, { ...result });
    return result.ok ? ExitCode.PASS : ExitCode.ASSERTION_FAIL;
  } finally {
    store.close();
  }
}

async function cmdDiff(argv: string[], cwd: string): Promise<number> {
  const format = parseFormat(argv);
  const args = stripFlags(argv);
  const [runA, runB] = args;
  if (!runA || !runB) {
    emit(format, "Usage: agent-replay diff <runA> <runB>", { ok: false, error: "missing_runs" });
    return ExitCode.INFRA_ERROR;
  }
  const { store } = openStore(cwd, argv);
  try {
    const a = store.getEvents(runA);
    const b = store.getEvents(runB);
    if (a.length === 0 || b.length === 0) {
      emit(format, "One or both runs have no events", {
        ok: false,
        error: "empty_run",
        runA: a.length,
        runB: b.length,
      });
      return ExitCode.INFRA_ERROR;
    }
    const diff = structuralDiff(a, b);
    const human = diff.equal
      ? `Structural diff: equal`
      : `Structural diff: ${diff.items.length} difference(s)\n${diff.items.map((i) => `  [${i.kind}] ${i.message}`).join("\n")}`;
    emit(format, human, { ok: diff.equal, items: diff.items, equal: diff.equal });
    return diff.equal ? ExitCode.PASS : ExitCode.ASSERTION_FAIL;
  } finally {
    store.close();
  }
}

async function cmdTest(argv: string[], cwd: string): Promise<number> {
  const format = parseFormat(argv);
  const args = stripFlags(argv);
  const fixtureName = args[0];
  if (!fixtureName) {
    emit(format, "Usage: agent-replay test <fixtureName> [--run <runId>] [--cassette <path>]", {
      ok: false,
      error: "missing_fixture",
    });
    return ExitCode.INVALID_FIXTURE;
  }

  const cassettePath = getFlag(argv, "cassette");
  let fixture: FixtureRecord | undefined;
  let events;

  try {
    if (cassettePath) {
      const data = readExport(cassettePath);
      fixture = data.fixtures?.find((f) => f.name === fixtureName);
      const runId = getFlag(argv, "run") ?? fixture?.sourceRunId;
      const entry = data.runs.find((r) => r.run.runId === runId) ?? data.runs[0];
      events = entry?.events;
    } else {
      const { store, projectId } = openStore(cwd, argv);
      try {
        fixture = store.getFixture(projectId, fixtureName);
        const runId = getFlag(argv, "run") ?? fixture?.sourceRunId;
        if (!runId) {
          emit(format, "No run specified and fixture missing sourceRunId", {
            ok: false,
            error: "missing_run",
          });
          return ExitCode.INFRA_ERROR;
        }
        events = store.getEvents(runId);
      } finally {
        store.close();
      }
    }
  } catch (err) {
    emit(format, `Infra error: ${err instanceof Error ? err.message : String(err)}`, {
      ok: false,
      error: "infra",
      message: err instanceof Error ? err.message : String(err),
    });
    return ExitCode.INFRA_ERROR;
  }

  const result = runFixtureAssertions(fixture, events);
  const human = result.ok
    ? `Fixture "${fixtureName}" PASS (${result.results.length} assertions)`
    : `Fixture "${fixtureName}" FAIL (exit ${result.exitCode})\n${result.errors.map((e) => `  - ${e}`).join("\n")}`;
  emit(format, human, { ...result });
  return result.exitCode;
}

async function cmdExport(argv: string[], cwd: string): Promise<number> {
  const format = parseFormat(argv);
  const args = stripFlags(argv);
  const outPath = args[0] ?? join(cwd, ".agent-replay", "export.json");
  const { store, projectId } = openStore(cwd, argv);
  try {
    const data = exportProject(store, projectId, { includeFixtures: true });
    mkdirSync(dirname(outPath), { recursive: true });
    writeExport(outPath, data);
    emit(format, `Exported ${data.runs.length} run(s) → ${outPath}\nintegrity: ${data.integrity}`, {
      ok: true,
      path: outPath,
      runs: data.runs.length,
      integrity: data.integrity,
    });
    return ExitCode.PASS;
  } finally {
    store.close();
  }
}

async function cmdImport(argv: string[], cwd: string): Promise<number> {
  const format = parseFormat(argv);
  const args = stripFlags(argv);
  const path = args[0];
  if (!path) {
    emit(format, "Usage: agent-replay import <path>", { ok: false, error: "missing_path" });
    return ExitCode.INFRA_ERROR;
  }
  const { store } = openStore(cwd, argv);
  try {
    const data = readExport(path);
    const result = importProject(store, data, { skipIntegrity: hasFlag(argv, "skip-integrity") });
    emit(
      format,
      result.ok
        ? `Imported ${result.runsImported} run(s), ${result.fixturesImported} fixture(s)`
        : `Import issues:\n${result.errors.map((e) => `  - ${e}`).join("\n")}`,
      { ...result },
    );
    return result.ok ? ExitCode.PASS : ExitCode.INFRA_ERROR;
  } finally {
    store.close();
  }
}

async function cmdDoctor(argv: string[], cwd: string): Promise<number> {
  const format = parseFormat(argv);
  const issues: string[] = [];
  const cfg = loadConfig(cwd);
  if (!cfg) {
    issues.push("No .agent-replay/config.json — run agent-replay init");
  } else {
    const dbPath = resolveDbPath(cfg, cwd);
    if (!existsSync(dbPath)) {
      issues.push(`SQLite missing at ${dbPath}`);
    } else {
      try {
        const store = new ReplayStore(dbPath);
        const version = store.getSchemaVersion();
        if (version !== SCHEMA_VERSION) {
          issues.push(`Schema version ${version} != ${SCHEMA_VERSION}`);
        }
        store.close();
      } catch (err) {
        issues.push(`Cannot open DB: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const ok = issues.length === 0;
  emit(
    format,
    ok
      ? `Doctor: OK\n  schema: ${SCHEMA_VERSION}\n  node: ${process.version}\n  offline mock: fail-closed\n  live-model verify: not in v0.1`
      : `Doctor: PROBLEMS\n${issues.map((i) => `  - ${i}`).join("\n")}`,
    {
      ok,
      schemaVersion: SCHEMA_VERSION,
      node: process.version,
      issues,
      modes: { offlineMock: true, liveTools: false, liveModel: false },
    },
  );
  return ok ? ExitCode.PASS : ExitCode.INFRA_ERROR;
}

async function cmdFixtureCreate(argv: string[], cwd: string): Promise<number> {
  const format = parseFormat(argv);
  const args = stripFlags(argv);
  // argv after "fixture create"
  const runId = args[0];
  const name = args[1];
  if (!runId || !name) {
    emit(format, "Usage: agent-replay fixture create <runId> <name>", {
      ok: false,
      error: "usage",
    });
    return ExitCode.INFRA_ERROR;
  }
  const { store, projectId } = openStore(cwd, argv);
  try {
    const events = store.getEvents(runId);
    if (events.length === 0) {
      emit(format, `No events for run ${runId}`, { ok: false, error: "empty_run" });
      return ExitCode.INFRA_ERROR;
    }
    const fixture: FixtureRecord = {
      fixtureId: createEventId(),
      projectId,
      name,
      sourceRunId: runId,
      createdAt: new Date().toISOString(),
      assertions: defaultAssertionsFromEvents(events),
    };
    store.saveFixture(fixture);
    const fixturePath = join(cwd, ".agent-replay", "fixtures", `${name}.json`);
    mkdirSync(join(cwd, ".agent-replay", "fixtures"), { recursive: true });
    writeFileSync(fixturePath, JSON.stringify(fixture, null, 2), "utf8");
    emit(
      format,
      `Created fixture "${name}" from ${runId} (${fixture.assertions.length} assertions)`,
      { ok: true, fixture, path: fixturePath },
    );
    return ExitCode.PASS;
  } finally {
    store.close();
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || hasFlag(argv, "help") || argv.includes("-h")) {
    process.stdout.write(usage());
    return ExitCode.PASS;
  }
  if (hasFlag(argv, "version") || argv.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return ExitCode.PASS;
  }

  const cwd = process.cwd();
  const cmd = argv[0];
  const rest = argv.slice(1);

  try {
    switch (cmd) {
      case "init":
        return await cmdInit(rest, cwd);
      case "list":
        return await cmdList(rest, cwd);
      case "inspect":
        return await cmdInspect(rest, cwd);
      case "replay":
        return await cmdReplay(rest, cwd);
      case "diff":
        return await cmdDiff(rest, cwd);
      case "test":
        return await cmdTest(rest, cwd);
      case "export":
        return await cmdExport(rest, cwd);
      case "import":
        return await cmdImport(rest, cwd);
      case "doctor":
        return await cmdDoctor(rest, cwd);
      case "fixture":
        if (rest[0] === "create") return await cmdFixtureCreate(rest.slice(1), cwd);
        process.stderr.write(`Unknown fixture subcommand. Try: fixture create\n`);
        return ExitCode.INFRA_ERROR;
      default:
        process.stderr.write(`Unknown command: ${cmd}\n\n${usage()}`);
        return ExitCode.INFRA_ERROR;
    }
  } catch (err) {
    const format = parseFormat(argv);
    const message = err instanceof Error ? err.message : String(err);
    emit(format, `Error: ${message}`, { ok: false, error: "infra", message });
    return ExitCode.INFRA_ERROR;
  }
}

const code = await main();
process.exit(code);
