import { describe, expect, it } from "vitest";
import type { PromptSection } from "../../prompt/types.js";
import { excludePromptSectionsForMode } from "../exclude-sections.js";

function capSection(capabilityId: string, key: string): PromptSection {
  return {
    name: capabilityId,
    key,
    content: "yo",
    lines: 1,
    tokens: 1,
    source: { type: "capability", capabilityId, capabilityName: capabilityId },
    included: true,
  };
}

describe("excludePromptSectionsForMode", () => {
  it("flips capability-sourced sections matching dead-cap ids", () => {
    const out = excludePromptSectionsForMode(
      [capSection("vibe", "cap-vibe-1"), capSection("r2", "cap-r2-1")],
      new Set(["vibe"]),
      "plan",
    );
    const flipped = out.find((s) => s.key === "cap-vibe-1");
    expect(flipped?.included).toBe(false);
    expect(flipped?.excludedReason).toBe("Filtered by mode: plan");
    const untouched = out.find((s) => s.key === "cap-r2-1");
    expect(untouched?.included).toBe(true);
  });

  it("returns input unchanged when dead-cap set is empty", () => {
    const sections = [capSection("vibe", "cap-vibe-1")];
    const out = excludePromptSectionsForMode(sections, new Set(), "plan");
    expect(out).toBe(sections);
  });

  it("preserves non-capability sources untouched", () => {
    const section: PromptSection = {
      name: "Identity",
      key: "identity",
      content: "id",
      lines: 1,
      tokens: 1,
      source: { type: "default", id: "identity" },
      included: true,
    };
    const out = excludePromptSectionsForMode([section], new Set(["vibe"]), "plan");
    expect(out[0]).toBe(section);
  });

  it("preserves already-excluded sections without rewriting", () => {
    const excluded: PromptSection = {
      name: "vibe",
      key: "cap-vibe-1",
      content: "",
      lines: 0,
      tokens: 0,
      source: { type: "capability", capabilityId: "vibe", capabilityName: "vibe" },
      included: false,
      excludedReason: "Earlier reason",
    };
    const out = excludePromptSectionsForMode([excluded], new Set(["vibe"]), "plan");
    expect(out[0]).toBe(excluded);
  });
});
