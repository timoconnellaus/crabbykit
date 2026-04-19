/**
 * Phase 0a — `mergeSections` helper unit tests.
 *
 * Encodes the bundle prompt-build rule:
 *  - `setup.prompt: string` is verbatim and SUPPRESSES capability sections
 *  - `setup.prompt: PromptOptions` runs the default builder and APPENDS
 *    capability section content
 *  - `setup.prompt` undefined runs the default builder and appends
 *
 * Phase 1 widens the input section type to also accept full
 * `PromptSection` entries; this test asserts the rule on the Phase 0a
 * input shape (`string | BundlePromptSection`).
 */

import { describe, expect, it } from "vitest";
import { mergeSections } from "../prompt/merge-sections.js";

describe("mergeSections", () => {
  it("returns the verbatim string when setup.prompt is a string (suppresses sections)", () => {
    const out = mergeSections("VERBATIM", ["SECTION_A", "SECTION_B"]);
    expect(out).toBe("VERBATIM");
  });

  it("returns the verbatim string even with no sections", () => {
    expect(mergeSections("ONLY", [])).toBe("ONLY");
  });

  it("with PromptOptions and capability sections, appends section strings after defaults", () => {
    const out = mergeSections({ agentName: "Helper" }, ["CAPSECTION_X"]);
    expect(out).toContain("Helper");
    expect(out).toContain("CAPSECTION_X");
    // Capability section appears AFTER default-builder output.
    expect(out.lastIndexOf("CAPSECTION_X")).toBeGreaterThan(out.lastIndexOf("Helper"));
  });

  it("with undefined prompt and capability sections, default-builder still runs and sections splice", () => {
    const out = mergeSections(undefined, ["EXTRA"]);
    expect(out).toContain("EXTRA");
    // Default builder output is non-empty even without options.
    expect(out.length).toBeGreaterThan("EXTRA".length);
  });

  it("with PromptOptions and no sections, returns default-builder output unchanged", () => {
    const baseOnly = mergeSections({ agentName: "X" }, []);
    expect(baseOnly).toContain("X");
  });

  it("BundlePromptSection: included entries contribute, excluded entries are skipped", () => {
    const out = mergeSections({ agentName: "Y" }, [
      { kind: "included", content: "INCLUDED_TEXT" },
      { kind: "excluded", reason: "feature-flagged off" },
    ]);
    expect(out).toContain("INCLUDED_TEXT");
    expect(out).not.toContain("feature-flagged off");
  });

  it("ignores empty-string entries and BundlePromptSection without content", () => {
    const out = mergeSections({ agentName: "Z" }, ["", { kind: "included" }, "REAL"]);
    expect(out).toContain("REAL");
  });
});
