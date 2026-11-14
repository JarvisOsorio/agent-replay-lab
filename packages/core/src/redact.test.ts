import { describe, expect, it } from "vitest";
import { containsSecret, REDACTED, redactValue } from "./redact.js";

describe("redact", () => {
  it("redacts sensitive keys before persist shapes", () => {
    const input = {
      apiKey: "sk-live-secret-value-123456",
      query: "hello",
      nested: { Authorization: "Bearer abcdefghijklmnop" },
    };
    const out = redactValue(input) as Record<string, unknown>;
    expect(out.apiKey).toBe(REDACTED);
    expect(out.query).toBe("hello");
    expect((out.nested as Record<string, unknown>).Authorization).toBe(REDACTED);
  });

  it("redacts secret patterns inside strings", () => {
    const out = redactValue({
      note: "use sk-abcdefghijklmnopqrstuvwxyz token",
    }) as { note: string };
    expect(out.note).toContain(REDACTED);
    expect(out.note).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });

  it("detects secrets with containsSecret", () => {
    expect(containsSecret({ token: "secret" })).toBe(true);
    expect(containsSecret({ city: "Mars" })).toBe(false);
  });
});
