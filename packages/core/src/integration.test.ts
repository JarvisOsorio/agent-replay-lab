import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { structuralDiff } from "./diff.js";
import { ExitCode } from "./exit-codes.js";
import { exportProject, importProject, readExport, writeExport } from "./export-import.js";
import { defaultAssertionsFromEvents, runFixtureAssertions } from "./fixtures.js";
import { createEventId } from "./events.js";
import { Replay } from "./recorder.js";
import { OfflineMockReplay, extractToolCalls, ReplayMismatchError } from "./replay.js";
import { ReplayStore } from "./storage.js";
import { wrapTool } from "./wrap-tool.js";
import { REDACTED } from "./redact.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "arl-"));
  dirs.push(d);
  return d;
}

describe("record → replay → diff → test (integration)", () => {
  it("records ≥3 tool calls, redacts secrets, offline replays, detects arg mismatch", async () => {
    const dir = tempDir();
    const store = new ReplayStore(join(dir, "store.sqlite"));
    store.ensureProject("demo", "demo", dir);

    const replay = new Replay({
      store,
      projectId: "demo",
      label: "happy-path",
      source: { framework: "basic-agent", adapter: "wrapTool" },
    });

    const getWeather = wrapTool(replay, "getWeather", async (args: { city: string }) => ({
      city: args.city,
      tempC: 21,
    }));
    const searchDocs = wrapTool(
      replay,
      "searchDocs",
      async (args: { query: string; apiKey: string }) => ({
        hits: [`doc:${args.query}`],
      }),
    );
    const sendSummary = wrapTool(replay, "sendSummary", async (args: { text: string }) => ({
      ok: true,
      len: args.text.length,
    }));

    await getWeather.execute({ city: "Berlin" });
    await searchDocs.execute({ query: "mars nights", apiKey: "sk-abcdefghijklmnopqrstuvwxyz12" });
    await sendSummary.execute({ text: "Berlin is 21C" });
    replay.complete();

    const events = store.getEvents(replay.runId);
    expect(events.filter((e) => e.type === "tool.called").length).toBe(3);
    expect(events.filter((e) => e.type === "tool.completed").length).toBe(3);

    // Privacy: persisted fixture must not contain the API key
    const blob = JSON.stringify(events);
    expect(blob).not.toContain("sk-abcdefghijklmnopqrstuvwxyz12");
    expect(blob).toContain(REDACTED);

    // Offline mock replay with same plan
    const calls = extractToolCalls(events);
    const mock = new OfflineMockReplay({ cassette: events, mode: "offline" });
    const result = await mock.runCalls(calls);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("offline");

    // Intentional arg regression — fail closed
    const bad = new OfflineMockReplay({ cassette: events });
    await expect(bad.stub("getWeather")({ city: "Munich" })).rejects.toBeInstanceOf(
      ReplayMismatchError,
    );

    // Missing tool — fail closed
    const miss = new OfflineMockReplay({ cassette: events });
    await expect(miss.stub("unknownTool")({})).rejects.toThrow(/OFFLINE_FAIL_CLOSED/);

    // Diff identical runs
    const diffOk = structuralDiff(events, events);
    expect(diffOk.equal).toBe(true);

    // Diff with drifted args on a cloned event stream
    const drifted = structuredClone(events);
    const called = drifted.find((e) => e.type === "tool.called")!;
    (called.payload.args as { city: string }).city = "Munich";
    const completed = drifted.find((e) => e.type === "tool.completed")!;
    (completed.payload.args as { city: string }).city = "Munich";
    const diffBad = structuralDiff(events, drifted);
    expect(diffBad.equal).toBe(false);
    expect(diffBad.items.some((i) => i.kind === "args_mismatch")).toBe(true);

    // Fixtures + exit codes
    const assertions = defaultAssertionsFromEvents(events);
    const fixture = {
      fixtureId: createEventId(),
      projectId: "demo",
      name: "golden",
      sourceRunId: replay.runId,
      createdAt: new Date().toISOString(),
      assertions,
    };
    store.saveFixture(fixture);

    const pass = runFixtureAssertions(fixture, events);
    expect(pass.exitCode).toBe(ExitCode.PASS);
    expect(assertions.some((a) => a.type === "tool.argsMatch")).toBe(true);
    expect(assertions.some((a) => a.type === "tool.responseMatch")).toBe(true);

    // Default fixture must fail on arg/response drift (stranger CI gate).
    const driftedFail = runFixtureAssertions(fixture, drifted);
    expect(driftedFail.exitCode).toBe(ExitCode.ASSERTION_FAIL);
    expect(driftedFail.errors.some((e) => /Args mismatch|Response mismatch/i.test(e))).toBe(true);

    const failAssert = runFixtureAssertions(
      {
        ...fixture,
        assertions: [{ type: "tool.called", toolName: "getWeather", count: 99 }],
      },
      events,
    );
    expect(failAssert.exitCode).toBe(ExitCode.ASSERTION_FAIL);

    const invalid = runFixtureAssertions(null, events);
    expect(invalid.exitCode).toBe(ExitCode.INVALID_FIXTURE);

    const infra = runFixtureAssertions(fixture, null);
    expect(infra.exitCode).toBe(ExitCode.INFRA_ERROR);

    // JSON export / import
    const exported = exportProject(store, "demo", { includeFixtures: true });
    const exportPath = join(dir, "trace.json");
    writeExport(exportPath, exported);
    const reloaded = readExport(exportPath);
    expect(reloaded.integrity).toBe(exported.integrity);
    expect(readFileSync(exportPath, "utf8")).not.toContain("sk-abcdefghijklmnopqrstuvwxyz12");

    const store2 = new ReplayStore(join(dir, "import.sqlite"));
    const imported = importProject(store2, reloaded);
    expect(imported.ok).toBe(true);
    expect(imported.runsImported).toBe(1);
    expect(store2.getEvents(replay.runId).length).toBe(events.length);

    // Remap into a different local project id (CLI stranger path after import).
    const store3 = new ReplayStore(join(dir, "remap.sqlite"));
    const remapped = importProject(store3, reloaded, { targetProjectId: "local-project" });
    expect(remapped.ok).toBe(true);
    expect(store3.listRuns("local-project")).toHaveLength(1);
    expect(store3.listRuns("demo")).toHaveLength(0);
    expect(store3.getFixture("local-project", "golden")?.name).toBe("golden");

    // Tamper detection
    const tampered = structuredClone(reloaded);
    tampered.runs[0]!.run.label = "TAMPERED";
    const refused = importProject(new ReplayStore(join(dir, "tamper.sqlite")), tampered);
    expect(refused.ok).toBe(false);
    expect(refused.errors.some((e) => e.includes("Integrity"))).toBe(true);

    store.close();
    store2.close();
    store3.close();
  });

  it("documents offline guarantee: mock replay never touches network", async () => {
    // This test itself makes no network calls; OfflineMockReplay only reads cassette memory.
    const store = new ReplayStore(":memory:");
    store.ensureProject("p", "p");
    const r = new Replay({ store, projectId: "p" });
    const t = wrapTool(r, "localOnly", async (a: { n: number }) => ({ n: a.n * 2 }));
    await t.execute({ n: 2 });
    r.complete();
    const events = r.getEvents();
    const mock = new OfflineMockReplay({ cassette: events });
    const out = await mock.stub("localOnly")({ n: 2 });
    expect(out).toEqual({ n: 4 });
    store.close();
  });
});
