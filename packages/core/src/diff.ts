import type { ReplayEvent } from "./events.js";
import { canonicalize } from "./normalize.js";

export interface StructuralDiffItem {
  kind:
    | "tool_order"
    | "tool_missing"
    | "tool_extra"
    | "args_mismatch"
    | "response_mismatch"
    | "status_mismatch"
    | "count_mismatch";
  message: string;
  path?: string;
  expected?: unknown;
  actual?: unknown;
}

export interface StructuralDiffResult {
  equal: boolean;
  items: StructuralDiffItem[];
}

interface ToolStep {
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  failed?: boolean;
  error?: string;
}

function extractToolSteps(events: ReplayEvent[]): ToolStep[] {
  const steps: ToolStep[] = [];
  const pending = new Map<string, ToolStep>();

  for (const ev of events) {
    if (ev.type === "tool.called") {
      const toolName = String(ev.payload.toolName ?? "");
      const args = (ev.payload.args ?? {}) as Record<string, unknown>;
      const corr =
        typeof ev.payload.correlationId === "string" ? ev.payload.correlationId : ev.eventId;
      const step: ToolStep = { toolName, args };
      pending.set(corr, step);
      steps.push(step);
    } else if (ev.type === "tool.completed" || ev.type === "tool.failed") {
      const corr =
        typeof ev.payload.correlationId === "string" ? ev.payload.correlationId : undefined;
      const step = corr ? pending.get(corr) : steps[steps.length - 1];
      if (!step) continue;
      if (ev.type === "tool.completed") {
        step.result = ev.payload.result;
      } else {
        step.failed = true;
        step.error = String(ev.payload.error ?? "unknown");
      }
    }
  }
  return steps;
}

function runStatus(events: ReplayEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i]!.type;
    if (t === "run.completed") return "completed";
    if (t === "run.failed") return "failed";
  }
  return "running";
}

/**
 * Structural comparison of two runs: tool name/order/args/response.
 * Severity taxonomy deferred — pass/fail + message only in v0.1.
 */
export function structuralDiff(
  baseline: ReplayEvent[],
  candidate: ReplayEvent[],
): StructuralDiffResult {
  const items: StructuralDiffItem[] = [];
  const a = extractToolSteps(baseline);
  const b = extractToolSteps(candidate);

  const statusA = runStatus(baseline);
  const statusB = runStatus(candidate);
  if (statusA !== statusB) {
    items.push({
      kind: "status_mismatch",
      message: `Run status differs: expected ${statusA}, got ${statusB}`,
      expected: statusA,
      actual: statusB,
    });
  }

  if (a.length !== b.length) {
    items.push({
      kind: "count_mismatch",
      message: `Tool call count differs: expected ${a.length}, got ${b.length}`,
      expected: a.length,
      actual: b.length,
    });
  }

  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const left = a[i];
    const right = b[i];
    const path = `tools[${i}]`;

    if (left && !right) {
      items.push({
        kind: "tool_missing",
        message: `Missing tool call at ${path}: ${left.toolName}`,
        path,
        expected: left.toolName,
      });
      continue;
    }
    if (!left && right) {
      items.push({
        kind: "tool_extra",
        message: `Unexpected tool call at ${path}: ${right.toolName}`,
        path,
        actual: right.toolName,
      });
      continue;
    }
    if (!left || !right) continue;

    if (left.toolName !== right.toolName) {
      items.push({
        kind: "tool_order",
        message: `Tool name mismatch at ${path}: expected ${left.toolName}, got ${right.toolName}`,
        path,
        expected: left.toolName,
        actual: right.toolName,
      });
      continue;
    }

    if (canonicalize(left.args) !== canonicalize(right.args)) {
      items.push({
        kind: "args_mismatch",
        message: `Args mismatch for ${left.toolName} at ${path}`,
        path: `${path}.args`,
        expected: left.args,
        actual: right.args,
      });
    }

    if (canonicalize(left.result) !== canonicalize(right.result)) {
      items.push({
        kind: "response_mismatch",
        message: `Response mismatch for ${left.toolName} at ${path}`,
        path: `${path}.result`,
        expected: left.result,
        actual: right.result,
      });
    }
  }

  return { equal: items.length === 0, items };
}
