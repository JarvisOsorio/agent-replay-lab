import { createEventId } from "./events.js";
import type { Replay } from "./recorder.js";

export type ToolFn<TArgs extends Record<string, unknown>, TResult> = (
  args: TArgs,
) => TResult | Promise<TResult>;

export interface WrappedTool<TArgs extends Record<string, unknown>, TResult> {
  name: string;
  execute: ToolFn<TArgs, TResult>;
}

/**
 * Capture seam: wrap a tool so every call is recorded (args + result/error).
 * Secrets in args/results are redacted by the Replay recorder before persist.
 */
export function wrapTool<TArgs extends Record<string, unknown>, TResult>(
  replay: Replay,
  name: string,
  fn: ToolFn<TArgs, TResult>,
): WrappedTool<TArgs, TResult> {
  const execute: ToolFn<TArgs, TResult> = async (args) => {
    const correlationId = createEventId();
    const spanId = createEventId();
    const started = Date.now();
    replay.recordToolCalled(name, args, { correlationId, spanId });
    try {
      const result = await fn(args);
      replay.recordToolCompleted(name, args, result, {
        correlationId,
        spanId,
        durationMs: Date.now() - started,
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      replay.recordToolFailed(name, args, message, {
        correlationId,
        spanId,
        durationMs: Date.now() - started,
      });
      throw err;
    }
  };

  return { name, execute };
}

/**
 * Build a mock tool map from recorded tool.completed events for offline replay.
 */
export function buildMockToolsFromEvents(
  events: Array<{ type: string; payload: Record<string, unknown> }>,
): Map<string, Array<{ args: Record<string, unknown>; result: unknown }>> {
  const map = new Map<string, Array<{ args: Record<string, unknown>; result: unknown }>>();
  for (const ev of events) {
    if (ev.type !== "tool.completed") continue;
    const toolName = String(ev.payload.toolName ?? "");
    const args = (ev.payload.args ?? {}) as Record<string, unknown>;
    const result = ev.payload.result;
    const list = map.get(toolName) ?? [];
    list.push({ args, result });
    map.set(toolName, list);
  }
  return map;
}
