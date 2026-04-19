import { describe, expect, it } from "vitest";
import { validateBundleRoutesAgainstKnownRoutes } from "../validate-routes.js";

describe("validateBundleRoutesAgainstKnownRoutes", () => {
  it("passes when no collisions", () => {
    const result = validateBundleRoutesAgainstKnownRoutes(
      [
        { method: "GET", path: "/files/list" },
        { method: "POST", path: "/files/move" },
      ],
      [
        { method: "GET", path: "/skills/registry" },
        { method: "POST", path: "/skills/install" },
      ],
    );
    expect(result.valid).toBe(true);
  });

  it("fails on a single colliding tuple with structured collisions", () => {
    const result = validateBundleRoutesAgainstKnownRoutes(
      [
        { method: "GET", path: "/files/list" },
        { method: "POST", path: "/skills/install" },
      ],
      [{ method: "POST", path: "/skills/install" }],
    );
    expect(result).toEqual({
      valid: false,
      collisions: [{ method: "POST", path: "/skills/install" }],
    });
  });

  it("dedups colliding tuples", () => {
    const result = validateBundleRoutesAgainstKnownRoutes(
      [
        { method: "POST", path: "/skills/install" },
        { method: "POST", path: "/skills/install" },
      ],
      [{ method: "POST", path: "/skills/install" }],
    );
    expect(result).toEqual({
      valid: false,
      collisions: [{ method: "POST", path: "/skills/install" }],
    });
  });

  it("treats undefined known as opt-out (always valid)", () => {
    const result = validateBundleRoutesAgainstKnownRoutes(
      [{ method: "GET", path: "/anywhere" }],
      undefined,
    );
    expect(result.valid).toBe(true);
  });

  it("treats undefined declared as no-op (always valid)", () => {
    const result = validateBundleRoutesAgainstKnownRoutes(undefined, [
      { method: "GET", path: "/anywhere" },
    ]);
    expect(result.valid).toBe(true);
  });

  it("differentiates by method (same path, different method, no collision)", () => {
    const result = validateBundleRoutesAgainstKnownRoutes(
      [{ method: "GET", path: "/skills/install" }],
      [{ method: "POST", path: "/skills/install" }],
    );
    expect(result.valid).toBe(true);
  });
});
