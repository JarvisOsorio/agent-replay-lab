/**
 * Privacy-first redaction applied BEFORE persist.
 * Traces are untrusted input after load — never execute payload content.
 */

const REDACTED = "[REDACTED]";

const SENSITIVE_KEY =
  /^(api[_-]?key|apikey|authorization|auth|token|access[_-]?token|refresh[_-]?token|secret|password|passwd|credential|private[_-]?key|bearer)$/i;

/** Common secret shapes in string values. */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9]{16,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._\-+=/]{16,}\b/gi,
  /\bAIza[0-9A-Za-z\-_]{20,}\b/g,
];

export interface RedactOptions {
  /** Extra key names treated as sensitive (case-insensitive). */
  sensitiveKeys?: string[];
  /** Extra regex patterns applied to string values. */
  patterns?: RegExp[];
}

export function redactValue(value: unknown, options: RedactOptions = {}): unknown {
  const extraKeys = (options.sensitiveKeys ?? []).map((k) => k.toLowerCase());
  const patterns = [...SECRET_PATTERNS, ...(options.patterns ?? [])];
  return redactInner(value, extraKeys, patterns);
}

function isSensitiveKey(key: string, extra: string[]): boolean {
  if (SENSITIVE_KEY.test(key)) return true;
  const lower = key.toLowerCase();
  return extra.some((k) => k === lower || lower.includes(k));
}

function redactString(s: string, patterns: RegExp[]): string {
  let out = s;
  for (const re of patterns) {
    // Reset lastIndex for global regexes reused across calls
    re.lastIndex = 0;
    out = out.replace(re, REDACTED);
  }
  return out;
}

function redactInner(value: unknown, extraKeys: string[], patterns: RegExp[]): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") {
    return redactString(value, patterns);
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactInner(v, extraKeys, patterns));
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (isSensitiveKey(k, extraKeys)) {
        out[k] = REDACTED;
      } else {
        out[k] = redactInner(v, extraKeys, patterns);
      }
    }
    return out;
  }
  return value;
}

export function containsSecret(value: unknown, options: RedactOptions = {}): boolean {
  const before = JSON.stringify(value);
  const after = JSON.stringify(redactValue(value, options));
  return before !== after;
}

export { REDACTED };
