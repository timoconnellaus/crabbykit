import { describe, expect, it } from "vitest";
import { validateActionCapabilityIds } from "../validate.js";

describe("validateActionCapabilityIds", () => {
  it("accepts a well-formed allow-list", () => {
    expect(() =>
      validateActionCapabilityIds(["files", "tavily-web-search", "skills"]),
    ).not.toThrow();
  });

  it("accepts an empty list", () => {
    expect(() => validateActionCapabilityIds([])).not.toThrow();
  });

  for (const reserved of ["agent-config", "schedules", "queue"]) {
    it(`rejects reserved id "${reserved}"`, () => {
      expect(() => validateActionCapabilityIds([reserved])).toThrow(
        new RegExp(`Bundle capability "${reserved}" cannot declare onAction`),
      );
    });
  }

  it("rejects empty string", () => {
    expect(() => validateActionCapabilityIds([""])).toThrow(/must be a non-empty string/);
  });
});
