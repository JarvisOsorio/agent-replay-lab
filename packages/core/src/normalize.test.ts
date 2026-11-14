import { describe, expect, it } from "vitest";
import { argsEqual, canonicalize, normalizeValue } from "./normalize.js";

describe("normalize", () => {
  it("sorts keys for stable canonical form", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it("drops volatile fields", () => {
    const a = normalizeValue({ city: "Berlin", requestId: "r1", timestamp: "t" });
    const b = normalizeValue({ city: "Berlin", requestId: "r2" });
    expect(a).toEqual(b);
  });

  it("argsEqual uses normalization", () => {
    expect(argsEqual({ z: 1, a: 2, request_id: "x" }, { a: 2, z: 1 })).toBe(true);
    expect(argsEqual({ a: 1 }, { a: 2 })).toBe(false);
  });
});
