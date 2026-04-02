import { describe, expect, it } from "vitest";
import { stableStringify } from "../stable-stringify.js";

describe("stableStringify", () => {
  it("produces identical output regardless of key order", () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe(stableStringify({ a: 1, b: 2 }));
  });

  it("handles nested objects with sorted keys", () => {
    const a = { z: { b: 1, a: 2 }, y: 3 };
    const b = { y: 3, z: { a: 2, b: 1 } };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it("handles arrays (preserves order)", () => {
    expect(stableStringify([1, 2, 3])).toBe("[1,2,3]");
    expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]));
  });

  it("handles primitives", () => {
    expect(stableStringify("hello")).toBe('"hello"');
    expect(stableStringify(42)).toBe("42");
    expect(stableStringify(true)).toBe("true");
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(undefined)).toBe("undefined");
  });

  it("handles empty object", () => {
    expect(stableStringify({})).toBe("{}");
  });

  it("handles empty array", () => {
    expect(stableStringify([])).toBe("[]");
  });

  it("handles mixed nested structures", () => {
    const value = { items: [{ z: 1, a: 2 }], name: "test" };
    const expected = '{"items":[{"a":2,"z":1}],"name":"test"}';
    expect(stableStringify(value)).toBe(expected);
  });
});
