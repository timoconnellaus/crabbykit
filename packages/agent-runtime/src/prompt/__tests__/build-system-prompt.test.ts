import { describe, expect, it } from "vitest";
import { buildDefaultSystemPrompt, buildDefaultSystemPromptSections } from "../build-system-prompt";
import type { PromptSection } from "../types";

describe("buildDefaultSystemPrompt", () => {
  it("returns all default sections with no options", () => {
    const result = buildDefaultSystemPrompt();
    expect(result).toContain("You are a helpful AI assistant");
    expect(result).toContain("## Safety");
    expect(result).toContain("## Runtime");
  });

  it("uses agent name in identity section", () => {
    const result = buildDefaultSystemPrompt({ agentName: "Gia" });
    expect(result).toContain("You are Gia, an AI assistant");
  });

  it("omits identity when set to false", () => {
    const result = buildDefaultSystemPrompt({ identity: false });
    expect(result).not.toContain("You are");
    expect(result).toContain("## Safety");
  });

  it("uses custom identity string", () => {
    const result = buildDefaultSystemPrompt({
      identity: "You are a pirate assistant. Arrr!",
    });
    expect(result).toContain("You are a pirate assistant. Arrr!");
    expect(result).not.toContain("helpful AI assistant");
  });

  it("omits safety when set to false", () => {
    const result = buildDefaultSystemPrompt({ safety: false });
    expect(result).not.toContain("## Safety");
    expect(result).toContain("You are a helpful AI assistant");
  });

  it("uses custom safety string", () => {
    const result = buildDefaultSystemPrompt({
      safety: "## Custom Safety\n- Be nice",
    });
    expect(result).toContain("## Custom Safety");
    expect(result).not.toContain("self-preservation");
  });

  it("omits runtime when set to false", () => {
    const result = buildDefaultSystemPrompt({ runtime: false });
    expect(result).not.toContain("## Runtime");
  });

  it("passes timezone to runtime section", () => {
    const result = buildDefaultSystemPrompt({ timezone: "UTC" });
    expect(result).toContain("Timezone: UTC");
  });

  it("appends additional sections", () => {
    const result = buildDefaultSystemPrompt({
      additionalSections: ["## Memory\nYou have persistent memory.", "## Tools\nUse tools wisely."],
    });
    expect(result).toContain("## Memory\nYou have persistent memory.");
    expect(result).toContain("## Tools\nUse tools wisely.");
  });

  it("skips empty additional sections", () => {
    const result = buildDefaultSystemPrompt({
      additionalSections: ["## Valid Section", ""],
    });
    expect(result).toContain("## Valid Section");
    // Empty string should not produce extra double newlines
    const doubleNewlines = result.match(/\n\n\n\n/g);
    expect(doubleNewlines).toBeNull();
  });

  it("joins sections with double newlines", () => {
    const result = buildDefaultSystemPrompt();
    // Identity and Safety should be separated by exactly \n\n
    const parts = result.split("\n\n");
    expect(parts.length).toBeGreaterThanOrEqual(3); // identity, safety, runtime
  });

  it("delegates to buildDefaultSystemPromptSections", () => {
    const sections = buildDefaultSystemPromptSections();
    const flat = buildDefaultSystemPrompt();
    expect(sections.map((s) => s.content).join("\n\n")).toBe(flat);
  });
});

describe("buildDefaultSystemPromptSections", () => {
  it("returns three default sections with correct names and keys", () => {
    const sections = buildDefaultSystemPromptSections();
    expect(sections).toHaveLength(3);
    expect(sections[0]).toMatchObject({ name: "Identity", key: "identity" });
    expect(sections[1]).toMatchObject({ name: "Safety", key: "safety" });
    expect(sections[2]).toMatchObject({ name: "Runtime", key: "runtime" });
  });

  it("populates content and line counts", () => {
    const sections = buildDefaultSystemPromptSections();
    for (const s of sections) {
      expect(s.content.length).toBeGreaterThan(0);
      expect(s.lines).toBe(s.content.split("\n").length);
    }
  });

  it("uses agent name in identity section", () => {
    const sections = buildDefaultSystemPromptSections({ agentName: "Gia" });
    expect(sections[0].content).toContain("You are Gia");
  });

  it("omits identity when set to false", () => {
    const sections = buildDefaultSystemPromptSections({ identity: false });
    expect(sections.find((s) => s.key === "identity")).toBeUndefined();
    expect(sections).toHaveLength(2);
  });

  it("uses custom identity string", () => {
    const sections = buildDefaultSystemPromptSections({ identity: "Custom identity" });
    const identity = sections.find((s) => s.key === "identity");
    expect(identity?.content).toBe("Custom identity");
  });

  it("omits safety when set to false", () => {
    const sections = buildDefaultSystemPromptSections({ safety: false });
    expect(sections.find((s) => s.key === "safety")).toBeUndefined();
    expect(sections).toHaveLength(2);
  });

  it("omits runtime when set to false", () => {
    const sections = buildDefaultSystemPromptSections({ runtime: false });
    expect(sections.find((s) => s.key === "runtime")).toBeUndefined();
    expect(sections).toHaveLength(2);
  });

  it("appends additional sections with numbered names and keys", () => {
    const sections = buildDefaultSystemPromptSections({
      additionalSections: ["## Memory\nRemember things.", "## Tools\nUse them."],
    });
    expect(sections).toHaveLength(5);
    expect(sections[3]).toMatchObject({
      name: "Additional (1)",
      key: "additional-1",
      content: "## Memory\nRemember things.",
      lines: 2,
    });
    expect(sections[4]).toMatchObject({
      name: "Additional (2)",
      key: "additional-2",
      content: "## Tools\nUse them.",
      lines: 2,
    });
  });

  it("skips empty additional sections", () => {
    const sections = buildDefaultSystemPromptSections({
      additionalSections: ["Valid", "", "Also valid"],
    });
    // Empty string is falsy, skipped
    expect(sections).toHaveLength(5); // 3 defaults + 2 valid additionals
    expect(sections[3].name).toBe("Additional (1)");
    expect(sections[4].name).toBe("Additional (3)"); // index 2 in the original array
  });

  it("returns empty array when all sections disabled", () => {
    const sections = buildDefaultSystemPromptSections({
      identity: false,
      safety: false,
      runtime: false,
    });
    expect(sections).toEqual([]);
  });

  it("passes timezone through to runtime section", () => {
    const sections = buildDefaultSystemPromptSections({ timezone: "UTC" });
    const runtime = sections.find((s) => s.key === "runtime");
    expect(runtime?.content).toContain("Timezone: UTC");
  });
});
