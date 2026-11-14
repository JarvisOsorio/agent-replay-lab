import type { ReplayEvent } from "./events.js";
import { argsEqual, canonicalize } from "./normalize.js";
import type { ToolFn } from "./wrap-tool.js";

/**
 * Verification modes (v0.1 ships offline mock only).
 * Never conflate these in docs or reports.
 *
 * - mock / offline: stub tools from cassette; fail closed if mock missing
 * - live-tools: (0.2) call real tools
 * - live-model: (0.2) call real model
 * - compare: structural diff only (see diff.ts)
 */
export type ReplayMode = "offline" | "strict";

export interface MockToolCall {
  toolName: string;
  args: Record<string, unknown>;
  correlationId?: string;
}

export interface OfflineReplayOptions {
  /** Recorded events used as the cassette. */
  cassette: ReplayEvent[];
  /**
   * Mode. v0.1: only offline/strict (same behavior — fail closed).
   * Flexible matching is explicitly deferred.
   */
  mode?: ReplayMode;
}

export interface OfflineReplayResult {
  mode: "offline";
  ok: boolean;
  calls: Array<{
    toolName: string;
    args: Record<string, unknown>;
    result?: unknown;
    error?: string;
  }>;
  errors: string[];
}

interface CassetteEntry {
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  used: boolean;
}

/**
 * Strict offline mock replay: match tool name + normalized args in recorded order.
 * Missing mock → error (fail closed). Unexpected tool → error.
 * Does NOT claim deterministic LLM behavior — tools only.
 */
export class OfflineMockReplay {
  private readonly queue: CassetteEntry[];
  private readonly byNameIndex = new Map<string, number[]>();
  readonly mode = "offline" as const;

  constructor(opts: OfflineReplayOptions) {
    this.queue = [];
    for (const ev of opts.cassette) {
      if (ev.type !== "tool.completed") continue;
      const toolName = String(ev.payload.toolName ?? "");
      const args = (ev.payload.args ?? {}) as Record<string, unknown>;
      const result = ev.payload.result;
      const idx = this.queue.length;
      this.queue.push({ toolName, args, result, used: false });
      const list = this.byNameIndex.get(toolName) ?? [];
      list.push(idx);
      this.byNameIndex.set(toolName, list);
    }
  }

  /** Next unused cassette entry for tool (strict order among same-name calls). */
  private take(toolName: string, args: Record<string, unknown>): CassetteEntry {
    const indices = this.byNameIndex.get(toolName);
    if (!indices || indices.length === 0) {
      throw new ReplayMissError(
        `OFFLINE_FAIL_CLOSED: no mock for tool "${toolName}" (args=${canonicalize(args)})`,
      );
    }

    // Prefer first unused entry with matching args (strict)
    for (const i of indices) {
      const entry = this.queue[i]!;
      if (entry.used) continue;
      if (argsEqual(entry.args, args)) {
        entry.used = true;
        return entry;
      }
    }

    // Same tool name exists but args mismatch — still fail closed
    const unused = indices.map((i) => this.queue[i]!).find((e) => !e.used);
    if (unused) {
      throw new ReplayMismatchError(
        `ARG_MISMATCH: tool "${toolName}" expected args ${canonicalize(unused.args)} got ${canonicalize(args)}`,
        unused.args,
        args,
      );
    }

    throw new ReplayMissError(
      `OFFLINE_FAIL_CLOSED: all mocks for tool "${toolName}" already consumed`,
    );
  }

  /**
   * Create a stub ToolFn that returns the recorded result or throws fail-closed.
   */
  stub<TArgs extends Record<string, unknown>, TResult = unknown>(
    toolName: string,
  ): ToolFn<TArgs, TResult> {
    return async (args: TArgs) => {
      const entry = this.take(toolName, args);
      return entry.result as TResult;
    };
  }

  /**
   * Execute a sequence of planned tool calls against the cassette.
   */
  async runCalls(calls: MockToolCall[]): Promise<OfflineReplayResult> {
    const errors: string[] = [];
    const out: OfflineReplayResult["calls"] = [];

    for (const call of calls) {
      try {
        const entry = this.take(call.toolName, call.args);
        out.push({
          toolName: call.toolName,
          args: call.args,
          result: entry.result,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(message);
        out.push({
          toolName: call.toolName,
          args: call.args,
          error: message,
        });
      }
    }

    // Unused cassette entries = agent skipped expected tools
    for (const entry of this.queue) {
      if (!entry.used) {
        errors.push(
          `UNEXPECTED_UNUSED_MOCK: recorded tool "${entry.toolName}" was not invoked (args=${canonicalize(entry.args)})`,
        );
      }
    }

    return {
      mode: "offline",
      ok: errors.length === 0,
      calls: out,
      errors,
    };
  }

  remaining(): CassetteEntry[] {
    return this.queue.filter((e) => !e.used);
  }
}

export class ReplayMissError extends Error {
  readonly code = "OFFLINE_FAIL_CLOSED";
  constructor(message: string) {
    super(message);
    this.name = "ReplayMissError";
  }
}

export class ReplayMismatchError extends Error {
  readonly code = "ARG_MISMATCH";
  readonly expected: Record<string, unknown>;
  readonly actual: Record<string, unknown>;
  constructor(message: string, expected: Record<string, unknown>, actual: Record<string, unknown>) {
    super(message);
    this.name = "ReplayMismatchError";
    this.expected = expected;
    this.actual = actual;
  }
}

/** Extract ordered tool.called payloads from a run (for replaying the same plan). */
export function extractToolCalls(events: ReplayEvent[]): MockToolCall[] {
  return events
    .filter((e) => e.type === "tool.called")
    .map((e) => ({
      toolName: String(e.payload.toolName ?? ""),
      args: (e.payload.args ?? {}) as Record<string, unknown>,
      correlationId:
        typeof e.payload.correlationId === "string" ? e.payload.correlationId : undefined,
    }));
}
