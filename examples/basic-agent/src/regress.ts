import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  OfflineMockReplay,
  ReplayStore,
  extractToolCalls,
  readExport,
  structuralDiff,
} from "@agent-replay-lab/core";
import { runBasicAgent } from "./agent.js";

/**
 * Intentional regression: agent calls getWeather with Munich instead of Berlin.
 * Offline mock + structural diff should detect the drift.
 */
const root = join(import.meta.dirname, "..");
const cassette = readExport(join(root, ".agent-replay", "cassette.json"));
const baseline = cassette.runs[0]?.events;
if (!baseline) {
  console.error("No baseline. Run: pnpm record");
  process.exit(3);
}

const dataDir = join(root, ".agent-replay");
mkdirSync(dataDir, { recursive: true });
const store = new ReplayStore(join(dataDir, "regress.sqlite"));
store.ensureProject("basic-agent", "basic-agent", root);

const { runId } = await runBasicAgent(store, "basic-agent", {
  label: "regressed",
  regressCity: "Munich",
});
const candidate = store.getEvents(runId);
store.close();

console.log("=== Intentional regression (city=Munich) ===");

const mock = new OfflineMockReplay({ cassette: baseline });
const replay = await mock.runCalls(extractToolCalls(candidate));
console.log("Offline replay against golden cassette:");
console.log(replay.ok ? "unexpected PASS" : "FAIL (expected)");
for (const e of replay.errors) console.log(`  - ${e}`);

const diff = structuralDiff(baseline, candidate);
console.log("Structural diff vs golden:");
console.log(diff.equal ? "unexpected equal" : `${diff.items.length} difference(s)`);
for (const i of diff.items) console.log(`  [${i.kind}] ${i.message}`);

const detected =
  !replay.ok &&
  diff.items.some((i) => i.kind === "args_mismatch" || i.kind === "response_mismatch");
if (!detected) {
  console.error("Regression was NOT detected — lab is broken");
  process.exit(1);
}

console.log("Regression detected as expected. Lab OK.");
process.exit(0);
