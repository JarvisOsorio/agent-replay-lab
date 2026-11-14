/**
 * Canonical JSON normalization for strict tool-arg matching.
 *
 * Rules (v0.1 — strict only):
 * - Recursively sort object keys
 * - Drop volatile fields by name (requestId, timestamp(s), etc.)
 * - Misses / mismatches are errors — never silent skips
 */

const DEFAULT_DROP_KEYS = new Set([
  "requestid",
  "request_id",
  "timestamp",
  "timestamps",
  "createdat",
  "created_at",
  "updatedat",
  "updated_at",
  "traceid",
  "trace_id",
  "spanid",
  "span_id",
]);

export interface NormalizeOptions {
  /** Extra key names to drop (case-insensitive). */
  dropKeys?: string[];
}

function shouldDrop(key: string, drop: Set<string>): boolean {
  return drop.has(key.toLowerCase());
}

export function normalizeValue(value: unknown, options: NormalizeOptions = {}): unknown {
  const drop = new Set(DEFAULT_DROP_KEYS);
  for (const k of options.dropKeys ?? []) {
    drop.add(k.toLowerCase());
  }
  return normalizeInner(value, drop);
}

function normalizeInner(value: unknown, drop: Set<string>): unknown {
  if (value === null || value === undefined) {
    return value ?? null;
  }
  if (Array.isArray(value)) {
    return value.map((v) => normalizeInner(v, drop));
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => !shouldDrop(k, drop))
      .sort((a, b) => a.localeCompare(b));
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      out[k] = normalizeInner(obj[k], drop);
    }
    return out;
  }
  return value;
}

/** Stable string for equality / hashing of tool args. */
export function canonicalize(value: unknown, options?: NormalizeOptions): string {
  return JSON.stringify(normalizeValue(value, options));
}

export function argsEqual(a: unknown, b: unknown, options?: NormalizeOptions): boolean {
  return canonicalize(a, options) === canonicalize(b, options);
}
