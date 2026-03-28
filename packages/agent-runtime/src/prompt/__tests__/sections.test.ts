import { describe, expect, it } from "vitest";
import { identitySection, runtimeSection, safetySection } from "../sections";

describe("identitySection", () => {
  it("returns default identity when no name given", () => {
    const result = identitySection();
    expect(result).toContain("You are a helpful AI assistant");
    expect(result).toContain("built to help users accomplish tasks");
    expect(result).toContain("multiple tools in sequence");
  });

  it("uses the agent name when provided", () => {
    const result = identitySection("Gia");
    expect(result).toContain("You are Gia, an AI assistant");
    expect(result).not.toContain("a helpful AI assistant");
  });
});

describe("safetySection", () => {
  it("returns safety guardrails", () => {
    const result = safetySection();
    expect(result).toContain("## Safety");
    expect(result).toContain("self-preservation");
    expect(result).toContain("human oversight");
    expect(result).toContain("stop, pause, or audit");
  });
});

describe("runtimeSection", () => {
  it("includes current date when no timezone", () => {
    const result = runtimeSection();
    expect(result).toContain("## Runtime");
    expect(result).toMatch(/Current date: \d{4}-\d{2}-\d{2}/);
    expect(result).not.toContain("Timezone:");
  });

  it("includes timezone and local time when timezone provided", () => {
    const result = runtimeSection({ timezone: "Australia/Sydney" });
    expect(result).toContain("## Runtime");
    expect(result).toContain("Timezone: Australia/Sydney");
    expect(result).toContain("Current time:");
  });

  it("falls back to date on invalid timezone", () => {
    const result = runtimeSection({ timezone: "Invalid/Zone" });
    expect(result).toContain("## Runtime");
    // Should fall back to date format
    expect(result).toMatch(/Current date: \d{4}-\d{2}-\d{2}/);
  });
});
