import { join } from "node:path";
import {
  OfflineMockReplay,
  extractToolCalls,
  readExport,
  runFixtureAssertions,
} from "@agent-replay-lab/core";

const root = join(import.meta.dirname, "..");
const cassette = readExport(join(root, ".agent-replay", "cassette.json"));
const entry = cassette.runs[0];
if (!entry) {
  console.error("No runs in cassette. Run: pnpm record");
  process.exit(3);
}

const events = entry.events;
const mock = new OfflineMockReplay({ cassette: events, mode: "offline" });
const result = await mock.runCalls(extractToolCalls(events));

console.log("=== Offline mock replay ===");
console.log(`mode: ${result.mode} (tools stubbed; live model NOT executed)`);
console.log(result.ok ? "PASS" : "FAIL");
if (!result.ok) {
  for (const e of result.errors) console.log(`  - ${e}`);
  process.exit(1);
}

const fixture = cassette.fixtures?.find((f) => f.name === "golden");
const test = runFixtureAssertions(fixture, events);
console.log(`=== Fixture test (exit ${test.exitCode}) ===`);
console.log(test.ok ? "PASS" : "FAIL");
process.exit(test.exitCode);
