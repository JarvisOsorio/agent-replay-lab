# Agent Replay Lab

**RECORD · REPLAY · TEST · VERIFY**

VCR for **tool I/O** in TypeScript agents — record once, mock-replay tools offline, CI-gate structural drift.

Local-first. SQLite + portable JSON. Not an observability dashboard, eval leaderboard, agent framework, or full-trajectory “deterministic agent” engine.

[![CI](https://github.com/JarvisOsorio/agent-replay-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/JarvisOsorio/agent-replay-lab/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

## Why

Your agent worked yesterday. Today it failed after a prompt or SDK change. Observability products answer _what happened?_ and usually **re-run live**. Agent Replay Lab answers a narrower question:

> Does this agent still take the **same tool path** (name / order / args / responses) against the **same recorded tool world**, offline, in CI?

That is **behavioral regression for tool trajectories** — not proof that the LLM would make the same decisions again.

## Honest modes (read this)

| Mode                   | What it does                                                  | In v0.1?      |
| ---------------------- | ------------------------------------------------------------- | ------------- |
| **offline / mock**     | Stub tools from the cassette; **fail closed** if mock missing | Yes (default) |
| **structural compare** | Diff tool name / order / args / response                      | Yes           |
| **live-tools**         | Call real tools                                               | No (0.2)      |
| **live-model**         | Call a real model                                             | No (0.2)      |

### What v0.1 does **not** replay

Offline mock stubs **tools only**. It does **not** re-execute or pin:

- LLM requests / responses / tool-selection decisions
- Agent state machines, retries, or parallel scheduling
- Clock, randomness, or other nondeterministic inputs

You can optionally **record** `model.requested` / `model.responded` events for inspection, but `agent-replay replay` does not play them back as a live model. Mock replay ≠ deterministic LLM verification. We never claim “full agent determinism” from stubbed tools alone.

The cassette category is **crowded** (Cassette, Agentic Stash, Agent VCR, StoneTape, TracePact, agent-retrace, AgentTape, …). Fail-closed offline replay, redaction, and CI diffs are not unique inventions — this repo’s bar is a small, honest TypeScript/SQLite knife, not an empty-market claim.

## Quick start

**v0.1 install path:** clone this repo (packages are **not** on npm yet). Node `>=22` + `pnpm` (see `packageManager` in root `package.json`).

```bash
git clone https://github.com/JarvisOsorio/agent-replay-lab.git
cd agent-replay-lab
pnpm install
pnpm build
pnpm test

# 5-minute proof
pnpm --filter @agent-replay-lab/example-basic-agent demo
```

Optional (advanced): after `pnpm build`, `pnpm pack` in `packages/core` (and rewrite CLI’s `workspace:*` dep to the core tarball before packing CLI) then `file:`-install into another project. Prefer the monorepo clone until packages are published.

### Capture seam (`wrapTool`)

```ts
import { Replay, ReplayStore, wrapTool } from "@agent-replay-lab/core";

const store = new ReplayStore(".agent-replay/store.sqlite");
store.ensureProject("demo", "demo");

const replay = new Replay({ store, projectId: "demo" });
const getWeather = wrapTool(replay, "getWeather", async (args: { city: string }) => {
  return { tempC: 21, city: args.city };
});

await getWeather.execute({ city: "Berlin" });
replay.complete();
```

Known secret **key names** and common token **shapes** are redacted before persist (best-effort first layer — not foolproof; not a PII/governance product). Extend via `redact` options; pair with [agentscrub](https://github.com/JarvisOsorio/agent-session-scrubber) for after-the-fact store remediation.

### CLI

```bash
pnpm --filter @agent-replay-lab/cli build
pnpm --filter @agent-replay-lab/cli exec agent-replay init my-agent
pnpm --filter @agent-replay-lab/cli exec agent-replay list
pnpm --filter @agent-replay-lab/cli exec agent-replay inspect <runId>
pnpm --filter @agent-replay-lab/cli exec agent-replay replay <runId>      # offline mock
pnpm --filter @agent-replay-lab/cli exec agent-replay diff <runA> <runB>
pnpm --filter @agent-replay-lab/cli exec agent-replay fixture create <runId> golden
pnpm --filter @agent-replay-lab/cli exec agent-replay test golden --json
pnpm --filter @agent-replay-lab/cli exec agent-replay test golden --run <candidateRunId>
pnpm --filter @agent-replay-lab/cli exec agent-replay export ./trace.json
pnpm --filter @agent-replay-lab/cli exec agent-replay import ./trace.json
pnpm --filter @agent-replay-lab/cli exec agent-replay doctor
```

Human and `--json` output. Offline by default. `import` remaps the cassette into the **local** project id so `list` / `replay` / `test` work immediately (integrity hash still verified against the file).

`fixture create` pins tool **sequence, args, and responses**. `test golden --run <otherRun>` fails (exit 1) on structural drift — same bar as `diff`.

### CI exit codes (`test`)

| Code | Meaning                     |
| ---- | --------------------------- |
| 0    | Pass                        |
| 1    | Assertion / regression fail |
| 2    | Invalid fixture             |
| 3    | Infrastructure error        |

Replay tests use in-memory / local cassette data and make **no network calls**. CI runs with network denied where the runner supports it; otherwise the offline guarantee is enforced by the mock engine (fail closed, no HTTP client).

## Packages

| Package                  | Role                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `@agent-replay-lab/core` | Events, `Replay` / `wrapTool`, redaction, SQLite, JSON export, offline replay, diff, fixtures |
| `@agent-replay-lab/cli`  | `agent-replay` commands                                                                       |
| `examples/basic-agent`   | record → replay → detect intentional regression                                               |

**Not in v0.1:** MCP adapter, OpenTelemetry adapter, flexible matching, semantic compare, dashboard, live auto-replay, telemetry, full LLM/state/clock cassette replay, behavioral policy / “agent assurance” enforcement.

## vs siblings & peers

| Tool                                                                               | Job                                                             | Boundary                                                                |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Agent Replay Lab**                                                               | App-level **tool** cassette + CI structural gates (TS / SQLite) | This repo — tools only in v0.1                                          |
| **mcp-pordego** (sibling)                                                          | MCP _gateway_ protocol replay                                   | Protocol proxy — do not dual-build here                                 |
| **agentscrub** (sibling)                                                           | Remediate secrets in _existing_ agent stores                    | We redact on write (best-effort); they scrub after                      |
| Langfuse / LangSmith / Phoenix                                                     | Trace + live dataset re-run                                     | Observe / score — not hermetic tool stubs                               |
| Cassette, Agentic Stash, Agent VCR, StoneTape, TracePact, agent-retrace, AgentTape | Peer cassette / trajectory tools                                | Overlap on record/replay/CI; we stay local SQLite + explicit mock≠model |

## Normalization (strict matching)

- Object keys sorted for canonical JSON
- Volatile fields dropped: `requestId`, `timestamp(s)`, `traceId`, `spanId`, …
- Misses and arg mismatches are **errors**, never silent skips

## License

Apache-2.0 © JarvisOsorio
