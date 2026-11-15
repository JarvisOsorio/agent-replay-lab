import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExitCode,
  OfflineMockReplay,
  Replay,
  ReplayStore,
  createEventId,
  defaultAssertionsFromEvents,
  exportProject,
  extractToolCalls,
  runFixtureAssertions,
  structuralDiff,
  wrapTool,
  writeExport,
  readExport,
} from "@agent-replay-lab/core";
import { defaultConfig, loadConfig, resolveDbPath, saveConfig } from "./config.js";
import { parseFormat, stripFlags } from "./output.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "arl-cli-"));
  dirs.push(d);
  return d;
}

describe("CLI helpers", () => {
  it("parses output format flags", () => {
    expect(parseFormat(["--json"])).toBe("json");
    expect(parseFormat(["--format", "human"])).toBe("human");
    expect(stripFlags(["list", "--json", "--format", "json"])).toEqual(["list"]);
  });

  it("init config + full record→replay→diff→test→export path", async () => {
    const dir = tempDir();
    const cfg = defaultConfig("cli-demo", dir);
    saveConfig(cfg, dir);
    expect(loadConfig(dir)?.projectId).toBe(cfg.projectId);

    const store = new ReplayStore(resolveDbPath(cfg, dir));
    store.ensureProject(cfg.projectId, cfg.name, dir);

    const replay = new Replay({ store, projectId: cfg.projectId, label: "cli-run" });
    const alpha = wrapTool(replay, "alpha", async (x: { n: number }) => ({ n: x.n + 1 }));
    const beta = wrapTool(replay, "beta", async (x: { s: string }) => ({ s: x.s.toUpperCase() }));
    const gamma = wrapTool(replay, "gamma", async (x: { ok: boolean }) => ({ ok: x.ok }));
    await alpha.execute({ n: 1 });
    await beta.execute({ s: "hi" });
    await gamma.execute({ ok: true });
    replay.complete();

    const events = store.getEvents(replay.runId);
    expect(events.filter((e) => e.type === "tool.completed")).toHaveLength(3);

    const mock = new OfflineMockReplay({ cassette: events });
    const replayResult = await mock.runCalls(extractToolCalls(events));
    expect(replayResult.ok).toBe(true);

    expect(structuralDiff(events, events).equal).toBe(true);

    const fixture = {
      fixtureId: createEventId(),
      projectId: cfg.projectId,
      name: "golden",
      sourceRunId: replay.runId,
      createdAt: new Date().toISOString(),
      assertions: defaultAssertionsFromEvents(events),
    };
    store.saveFixture(fixture);
    expect(runFixtureAssertions(fixture, events).exitCode).toBe(ExitCode.PASS);
    expect(
      runFixtureAssertions(
        { ...fixture, assertions: [{ type: "tool.called", toolName: "alpha", count: 9 }] },
        events,
      ).exitCode,
    ).toBe(ExitCode.ASSERTION_FAIL);

    const exported = exportProject(store, cfg.projectId, { includeFixtures: true });
    const cassette = join(dir, "cassette.json");
    writeExport(cassette, exported);
    expect(existsSync(cassette)).toBe(true);
    expect(readExport(cassette).fixtures?.[0]?.name).toBe("golden");

    // Missing fixture name → exit 2 (invalid fixture), not infra 3
    expect(runFixtureAssertions(undefined, events).exitCode).toBe(ExitCode.INVALID_FIXTURE);

    store.close();
  });
});
