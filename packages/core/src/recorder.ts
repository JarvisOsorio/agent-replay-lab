import {
  createEventId,
  createRunId,
  nowIso,
  type EventSource,
  type ReplayEvent,
  type ReplayEventType,
  type RunRecord,
} from "./events.js";
import { redactValue, type RedactOptions } from "./redact.js";
import { ReplayStore } from "./storage.js";

export type CaptureMode = "metadata" | "standard" | "custom";

export interface RecorderOptions {
  store: ReplayStore;
  projectId: string;
  label?: string;
  /** Default: standard — capture tool args + results (after redaction). */
  mode?: CaptureMode;
  redact?: RedactOptions;
  source?: EventSource;
  metadata?: Record<string, unknown>;
}

/**
 * Records a single agent run. Redaction runs before every persist.
 */
export class Replay {
  readonly runId: string;
  private sequence = 0;
  private readonly store: ReplayStore;
  private readonly mode: CaptureMode;
  private readonly redactOpts: RedactOptions;
  private readonly source?: EventSource;
  private closed = false;

  constructor(opts: RecorderOptions) {
    this.store = opts.store;
    this.mode = opts.mode ?? "standard";
    this.redactOpts = opts.redact ?? {};
    this.source = opts.source;
    this.runId = createRunId();

    const run: RunRecord = {
      runId: this.runId,
      projectId: opts.projectId,
      startedAt: nowIso(),
      status: "running",
      label: opts.label,
      metadata: opts.metadata,
    };
    this.store.insertRun(run);
    this.emit("run.started", {
      label: opts.label,
      mode: this.mode,
    });
  }

  get nextSequence(): number {
    return this.sequence;
  }

  private emit(
    type: ReplayEventType,
    payload: Record<string, unknown>,
    extra?: Partial<Pick<ReplayEvent, "parentEventId" | "spanId" | "metadata">>,
  ): ReplayEvent {
    if (this.closed) {
      throw new Error("Replay recorder is closed");
    }
    const redactedPayload =
      this.mode === "metadata"
        ? { keys: Object.keys(payload) }
        : (redactValue(payload, this.redactOpts) as Record<string, unknown>);

    const event: ReplayEvent = {
      eventId: createEventId(),
      runId: this.runId,
      sequence: this.sequence++,
      timestamp: nowIso(),
      type,
      parentEventId: extra?.parentEventId,
      spanId: extra?.spanId,
      source: this.source,
      payload: redactedPayload,
      metadata: extra?.metadata
        ? (redactValue(extra.metadata, this.redactOpts) as Record<string, unknown>)
        : undefined,
    };
    this.store.insertEvent(event);
    return event;
  }

  recordToolCalled(
    toolName: string,
    args: Record<string, unknown>,
    opts?: { correlationId?: string; parentEventId?: string; spanId?: string },
  ): ReplayEvent {
    return this.emit(
      "tool.called",
      {
        toolName,
        args,
        correlationId: opts?.correlationId,
      },
      { parentEventId: opts?.parentEventId, spanId: opts?.spanId },
    );
  }

  recordToolCompleted(
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
    opts?: {
      correlationId?: string;
      parentEventId?: string;
      spanId?: string;
      durationMs?: number;
    },
  ): ReplayEvent {
    return this.emit(
      "tool.completed",
      {
        toolName,
        args,
        result,
        durationMs: opts?.durationMs,
        correlationId: opts?.correlationId,
      },
      { parentEventId: opts?.parentEventId, spanId: opts?.spanId },
    );
  }

  recordToolFailed(
    toolName: string,
    args: Record<string, unknown>,
    error: string,
    opts?: {
      correlationId?: string;
      parentEventId?: string;
      spanId?: string;
      durationMs?: number;
    },
  ): ReplayEvent {
    return this.emit(
      "tool.failed",
      {
        toolName,
        args,
        error,
        durationMs: opts?.durationMs,
        correlationId: opts?.correlationId,
      },
      { parentEventId: opts?.parentEventId, spanId: opts?.spanId },
    );
  }

  recordModelRequested(payload: Record<string, unknown>): ReplayEvent {
    return this.emit("model.requested", payload);
  }

  recordModelResponded(payload: Record<string, unknown>): ReplayEvent {
    return this.emit("model.responded", payload);
  }

  recordMessage(role: string, content: string): ReplayEvent {
    return this.emit("agent.message", { role, content });
  }

  recordCustom(name: string, data: Record<string, unknown>): ReplayEvent {
    return this.emit("custom.event", { name, ...data });
  }

  complete(metadata?: Record<string, unknown>): void {
    this.emit("run.completed", { ...(metadata ?? {}) });
    this.store.updateRun(this.runId, {
      status: "completed",
      completedAt: nowIso(),
      metadata,
    });
    this.closed = true;
  }

  fail(error: string, metadata?: Record<string, unknown>): void {
    this.emit("run.failed", { error, ...(metadata ?? {}) });
    this.store.updateRun(this.runId, {
      status: "failed",
      completedAt: nowIso(),
      metadata: { error, ...(metadata ?? {}) },
    });
    this.closed = true;
  }

  getEvents(): ReplayEvent[] {
    return this.store.getEvents(this.runId);
  }
}
