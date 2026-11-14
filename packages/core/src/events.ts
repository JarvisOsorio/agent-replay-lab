/** Schema version for persisted traces / exports. */
export const SCHEMA_VERSION = "0.1.0";

export type ReplayEventType =
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "model.requested"
  | "model.responded"
  | "tool.called"
  | "tool.completed"
  | "tool.failed"
  | "tool.retried"
  | "agent.message"
  | "custom.event";

export interface EventSource {
  framework?: string;
  provider?: string;
  adapter?: string;
}

export interface ReplayEvent {
  eventId: string;
  runId: string;
  sequence: number;
  timestamp: string;
  type: ReplayEventType;
  parentEventId?: string;
  spanId?: string;
  source?: EventSource;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface RunRecord {
  runId: string;
  projectId: string;
  startedAt: string;
  completedAt?: string;
  status: "running" | "completed" | "failed";
  label?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolCallPayload {
  toolName: string;
  args: Record<string, unknown>;
  correlationId?: string;
}

export interface ToolResultPayload {
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  durationMs?: number;
  correlationId?: string;
  error?: string;
}

export function createEventId(): string {
  return `evt_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function createRunId(): string {
  return `run_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
