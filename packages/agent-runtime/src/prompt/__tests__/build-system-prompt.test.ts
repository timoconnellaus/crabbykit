import { describe, expect, it } from "vitest";
import { buildDefaultSystemPrompt } from "../build-system-prompt";

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
});
