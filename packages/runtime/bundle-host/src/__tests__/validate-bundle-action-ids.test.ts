import { describe, expect, it } from "vitest";
import { validateBundleActionIdsAgainstKnownIds } from "../validate-routes.js";

describe("validateBundleActionIdsAgainstKnownIds", () => {
  it("passes when no collisions", () => {
    const result = validateBundleActionIdsAgainstKnownIds(["files-bundle"], ["skills", "tavily"]);
    expect(result.valid).toBe(true);
  });

  it("fails on a single colliding id with structured collidingIds", () => {
    const result = validateBundleActionIdsAgainstKnownIds(
      ["tavily-web-search", "files-bundle"],
      ["tavily-web-search"],
    );
    expect(result).toEqual({ valid: false, collidingIds: ["tavily-web-search"] });
  });

  it("dedups colliding ids", () => {
    const result = validateBundleActionIdsAgainstKnownIds(["tavily", "tavily"], ["tavily"]);
    expect(result).toEqual({ valid: false, collidingIds: ["tavily"] });
  });

  it("treats undefined knownCapabilityIds as opt-out (always valid)", () => {
    const result = validateBundleActionIdsAgainstKnownIds(["any"], undefined);
    expect(result.valid).toBe(true);
  });

  it("treats undefined declared as no-op (always valid)", () => {
    const result = validateBundleActionIdsAgainstKnownIds(undefined, ["any"]);
    expect(result.valid).toBe(true);
  });

  it("accepts a Set as the known parameter", () => {
    const result = validateBundleActionIdsAgainstKnownIds(
      ["tavily"],
      new Set(["tavily", "skills"]),
    );
    expect(result).toEqual({ valid: false, collidingIds: ["tavily"] });
  });
});
