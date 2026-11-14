import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  ReplayStore,
  createEventId,
  defaultAssertionsFromEvents,
  exportProject,
  writeExport,
} from "@agent-replay-lab/core";
import { runBasicAgent } from "./agent.js";

const root = join(import.meta.dirname, "..");
const dataDir = join(root, ".agent-replay");
mkdirSync(dataDir, { recursive: true });

const projectId = "basic-agent";
const store = new ReplayStore(join(dataDir, "store.sqlite"));
store.ensureProject(projectId, "basic-agent", root);

const { runId } = await runBasicAgent(store, projectId, { label: "golden-record" });
const events = store.getEvents(runId);

const fixture = {
  fixtureId: createEventId(),
  projectId,
  name: "golden",
  sourceRunId: runId,
  createdAt: new Date().toISOString(),
  assertions: defaultAssertionsFromEvents(events),
};
store.saveFixture(fixture);

const exported = exportProject(store, projectId, { includeFixtures: true });
writeExport(join(dataDir, "cassette.json"), exported);

console.log(`Recorded run ${runId}`);
console.log(`  tools: ${events.filter((e) => e.type === "tool.completed").length}`);
console.log(`  fixture: golden (${fixture.assertions.length} assertions)`);
console.log(`  cassette: .agent-replay/cassette.json`);
console.log(
  `  secrets redacted: ${!JSON.stringify(events).includes("sk-demo-abcdefghijklmnopqrstuvwxyz")}`,
);

store.close();
