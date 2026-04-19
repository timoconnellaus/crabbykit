/**
 * Phase 1 — `normalizeBundlePromptSection` unit tests (task 3.12).
 *
 * Each accepted input form produces the expected normalized
 * {@link PromptSection}; unsupported entries return `null` so the
 * caller can skip and emit a single warning per turn.
 */

import { describe, expect, it } from "vitest";
import { normalizeBundlePromptSection } from "../prompt/normalize-bundle-section.js";

describe("normalizeBundlePromptSection", () => {
  it("bare string → custom-source included section", () => {
    const out = normalizeBundlePromptSection("hello", "tavily-web-search", "Tavily", 0);
    expect(out).not.toBeNull();
    expect(out?.included).toBe(true);
    expect(out?.source).toEqual({ type: "custom" });
    expect(out?.content).toBe("hello");
    expect(out?.key).toBe("cap-tavily-web-search-0");
  });

  it("BundlePromptSection (included) → capability source attribution", () => {
    const out = normalizeBundlePromptSection(
      { kind: "included", content: "hi", name: "Greeting" },
      "my-cap",
      "My Cap",
      2,
    );
    expect(out?.source).toEqual({
      type: "capability",
      capabilityId: "my-cap",
      capabilityName: "My Cap",
    });
    expect(out?.included).toBe(true);
    expect(out?.content).toBe("hi");
    expect(out?.name).toBe("Greeting");
    expect(out?.key).toBe("cap-my-cap-2");
  });

  it("BundlePromptSection (excluded) populates excludedReason", () => {
    const out = normalizeBundlePromptSection(
      { kind: "excluded", reason: "feature-flagged off" },
      "x",
      "X",
      0,
    );
    expect(out?.included).toBe(false);
    expect(out?.excludedReason).toBe("feature-flagged off");
    expect(out?.content).toBe("");
    expect(out?.lines).toBe(0);
    expect(out?.tokens).toBe(0);
  });

  it("BundlePromptSection (excluded) without reason gets a default", () => {
    const out = normalizeBundlePromptSection({ kind: "excluded" }, "x", "X", 0);
    expect(out?.excludedReason).toBe("Excluded by capability");
  });

  it("full PromptSection passes through with default-fill for missing optional fields", () => {
    const out = normalizeBundlePromptSection(
      {
        name: "Custom",
        key: "explicit-key",
        content: "Y",
        lines: 9,
        tokens: 9,
        source: { type: "capability", capabilityId: "x", capabilityName: "X" },
        included: true,
      },
      "x",
      "X",
      0,
    );
    expect(out?.name).toBe("Custom");
    expect(out?.key).toBe("explicit-key");
    expect(out?.content).toBe("Y");
    expect(out?.lines).toBe(9);
    expect(out?.tokens).toBe(9);
    expect(out?.source).toEqual({ type: "capability", capabilityId: "x", capabilityName: "X" });
  });

  it("malformed entry (null) returns null", () => {
    expect(normalizeBundlePromptSection(null, "x", "X", 0)).toBeNull();
  });

  it("malformed entry (wrong kind) returns null", () => {
    expect(normalizeBundlePromptSection({ kind: "wat" }, "x", "X", 0)).toBeNull();
  });

  it("malformed entry (number) returns null", () => {
    expect(normalizeBundlePromptSection(42, "x", "X", 0)).toBeNull();
  });
});
