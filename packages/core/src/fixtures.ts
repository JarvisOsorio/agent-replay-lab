import type { ReplayEvent } from "./events.js";
import { argsEqual, canonicalize } from "./normalize.js";
import { ExitCode, type ExitCodeValue } from "./exit-codes.js";
import type { AssertionSpec, FixtureRecord } from "./storage.js";

export interface AssertionResult {
  assertion: AssertionSpec;
  ok: boolean;
  message: string;
}

export interface FixtureTestResult {
  ok: boolean;
  exitCode: ExitCodeValue;
  results: AssertionResult[];
  errors: string[];
}

function toolCompleted(events: ReplayEvent[]) {
  return events.filter((e) => e.type === "tool.completed");
}

function toolCalled(events: ReplayEvent[]) {
  return events.filter((e) => e.type === "tool.called");
}

function runStatus(events: ReplayEvent[]): "completed" | "failed" | "running" {
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i]!.type;
    if (t === "run.completed") return "completed";
    if (t === "run.failed") return "failed";
  }
  return "running";
}

function evalAssertion(events: ReplayEvent[], assertion: AssertionSpec): AssertionResult {
  switch (assertion.type) {
    case "tool.called": {
      const matches = toolCalled(events).filter((e) => e.payload.toolName === assertion.toolName);
      const expected = assertion.count ?? 1;
      const ok = matches.length === expected;
      return {
        assertion,
        ok,
        message: ok
          ? `tool.called ${assertion.toolName} x${expected}`
          : `Expected tool.called ${assertion.toolName} x${expected}, got ${matches.length}`,
      };
    }
    case "tool.notCalled": {
      const matches = toolCalled(events).filter((e) => e.payload.toolName === assertion.toolName);
      const ok = matches.length === 0;
      return {
        assertion,
        ok,
        message: ok
          ? `tool.notCalled ${assertion.toolName}`
          : `Expected ${assertion.toolName} not called, saw ${matches.length}`,
      };
    }
    case "tool.argsMatch": {
      const matches = toolCalled(events).filter((e) => e.payload.toolName === assertion.toolName);
      const idx = (assertion.occurrence ?? 1) - 1;
      const ev = matches[idx];
      if (!ev) {
        return {
          assertion,
          ok: false,
          message: `No ${assertion.toolName} call at occurrence ${idx + 1}`,
        };
      }
      const args = (ev.payload.args ?? {}) as Record<string, unknown>;
      const ok = argsEqual(args, assertion.args);
      return {
        assertion,
        ok,
        message: ok
          ? `args match for ${assertion.toolName}`
          : `Args mismatch for ${assertion.toolName}: expected ${canonicalize(assertion.args)} got ${canonicalize(args)}`,
      };
    }
    case "tool.responseMatch": {
      const matches = toolCompleted(events).filter(
        (e) => e.payload.toolName === assertion.toolName,
      );
      const idx = (assertion.occurrence ?? 1) - 1;
      const ev = matches[idx];
      if (!ev) {
        return {
          assertion,
          ok: false,
          message: `No ${assertion.toolName} completion at occurrence ${idx + 1}`,
        };
      }
      const ok = canonicalize(ev.payload.result) === canonicalize(assertion.result);
      return {
        assertion,
        ok,
        message: ok
          ? `response match for ${assertion.toolName}`
          : `Response mismatch for ${assertion.toolName}`,
      };
    }
    case "noUnexpectedTools": {
      const allowed = new Set(assertion.allowed);
      const unexpected = [
        ...new Set(
          toolCalled(events)
            .map((e) => String(e.payload.toolName ?? ""))
            .filter((n) => n && !allowed.has(n)),
        ),
      ];
      const ok = unexpected.length === 0;
      return {
        assertion,
        ok,
        message: ok ? "no unexpected tools" : `Unexpected tools: ${unexpected.join(", ")}`,
      };
    }
    case "sequence": {
      const names = toolCalled(events).map((e) => String(e.payload.toolName ?? ""));
      const ok = canonicalize(names) === canonicalize(assertion.toolNames);
      return {
        assertion,
        ok,
        message: ok
          ? "sequence matches"
          : `Sequence mismatch: expected [${assertion.toolNames.join(", ")}] got [${names.join(", ")}]`,
      };
    }
    case "run.status": {
      const status = runStatus(events);
      const ok = status === assertion.status;
      return {
        assertion,
        ok,
        message: ok
          ? `run.status ${status}`
          : `Expected run.status ${assertion.status}, got ${status}`,
      };
    }
    default: {
      const _exhaustive: never = assertion;
      return {
        assertion: _exhaustive,
        ok: false,
        message: "Unknown assertion type",
      };
    }
  }
}

/**
 * Run fixture assertions against a candidate event stream.
 * Exit codes: 0 pass, 1 assertion fail, 2 invalid fixture, 3 infra.
 */
export function runFixtureAssertions(
  fixture: FixtureRecord | null | undefined,
  events: ReplayEvent[] | null | undefined,
): FixtureTestResult {
  if (!fixture) {
    return {
      ok: false,
      exitCode: ExitCode.INVALID_FIXTURE,
      results: [],
      errors: ["Invalid fixture: fixture is missing"],
    };
  }
  if (!Array.isArray(fixture.assertions) || fixture.assertions.length === 0) {
    return {
      ok: false,
      exitCode: ExitCode.INVALID_FIXTURE,
      results: [],
      errors: ["Invalid fixture: assertions must be a non-empty array"],
    };
  }
  if (!events) {
    return {
      ok: false,
      exitCode: ExitCode.INFRA_ERROR,
      results: [],
      errors: ["Infrastructure error: events unavailable"],
    };
  }

  try {
    const results = fixture.assertions.map((a) => evalAssertion(events, a));
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      return {
        ok: false,
        exitCode: ExitCode.ASSERTION_FAIL,
        results,
        errors: failed.map((f) => f.message),
      };
    }
    return {
      ok: true,
      exitCode: ExitCode.PASS,
      results,
      errors: [],
    };
  } catch (err) {
    return {
      ok: false,
      exitCode: ExitCode.INFRA_ERROR,
      results: [],
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }
}

export function defaultAssertionsFromEvents(events: ReplayEvent[]): AssertionSpec[] {
  const called = toolCalled(events);
  const completed = toolCompleted(events);
  const names = called.map((e) => String(e.payload.toolName ?? ""));
  const unique = [...new Set(names)];
  const assertions: AssertionSpec[] = [
    { type: "run.status", status: runStatus(events) === "failed" ? "failed" : "completed" },
    { type: "sequence", toolNames: names },
    { type: "noUnexpectedTools", allowed: unique },
  ];
  for (const name of unique) {
    const count = names.filter((n) => n === name).length;
    assertions.push({ type: "tool.called", toolName: name, count });
  }
  // Pin args + responses so `fixture create` + `test --run <candidate>` catches
  // structural drift (e.g. city/Berlin→Munich), not only tool name/count.
  const occurrenceByName = new Map<string, number>();
  for (const ev of called) {
    const toolName = String(ev.payload.toolName ?? "");
    if (!toolName) continue;
    const occurrence = (occurrenceByName.get(toolName) ?? 0) + 1;
    occurrenceByName.set(toolName, occurrence);
    const args = (ev.payload.args ?? {}) as Record<string, unknown>;
    assertions.push({ type: "tool.argsMatch", toolName, args, occurrence });
  }
  const responseOccurrence = new Map<string, number>();
  for (const ev of completed) {
    const toolName = String(ev.payload.toolName ?? "");
    if (!toolName) continue;
    const occurrence = (responseOccurrence.get(toolName) ?? 0) + 1;
    responseOccurrence.set(toolName, occurrence);
    assertions.push({
      type: "tool.responseMatch",
      toolName,
      result: ev.payload.result,
      occurrence,
    });
  }
  return assertions;
}
