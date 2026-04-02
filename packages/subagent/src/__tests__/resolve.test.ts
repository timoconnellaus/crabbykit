import { describe, expect, it } from "vitest";
import { resolveProfile } from "../resolve.js";
import type { SubagentProfile } from "../types.js";

// Minimal mock tools
function mockTool(name: string) {
  return {
    name,
    label: name,
    description: `Mock ${name}`,
    parameters: {},
    execute: async () => ({ content: [{ type: "text" as const, text: "" }], details: {} }),
  };
}

const PARENT_PROMPT = "You are a helpful agent.";
const PARENT_TOOLS = [
  mockTool("file_read"),
  mockTool("file_write"),
  mockTool("file_edit"),
  mockTool("grep"),
  mockTool("file_list"),
  mockTool("tavily_search"),
];

describe("resolveProfile", () => {
  it("resolves static system prompt", () => {
    const profile: SubagentProfile = {
      id: "test",
      name: "Test",
      description: "Test agent",
      systemPrompt: "Custom prompt",
    };

    const resolved = resolveProfile(profile, PARENT_PROMPT, PARENT_TOOLS);

    expect(resolved.systemPrompt).toBe("Custom prompt");
    expect(resolved.profile).toBe(profile);
  });

  it("resolves function system prompt with parent context", () => {
    const profile: SubagentProfile = {
      id: "test",
      name: "Test",
      description: "Test agent",
      systemPrompt: (parent) => `${parent}\n\nAdditional instructions.`,
    };

    const resolved = resolveProfile(profile, PARENT_PROMPT, PARENT_TOOLS);

    expect(resolved.systemPrompt).toBe("You are a helpful agent.\n\nAdditional instructions.");
  });

  it("inherits all parent tools when no allowlist", () => {
    const profile: SubagentProfile = {
      id: "test",
      name: "Test",
      description: "Test agent",
      systemPrompt: "Test",
    };

    const resolved = resolveProfile(profile, PARENT_PROMPT, PARENT_TOOLS);

    expect(resolved.tools).toHaveLength(PARENT_TOOLS.length);
    expect(resolved.tools.map((t) => t.name)).toEqual(PARENT_TOOLS.map((t) => t.name));
  });

  it("filters tools by allowlist", () => {
    const profile: SubagentProfile = {
      id: "explorer",
      name: "Explorer",
      description: "Read-only explorer",
      systemPrompt: "Explore the codebase",
      tools: ["file_read", "grep", "file_list"],
    };

    const resolved = resolveProfile(profile, PARENT_PROMPT, PARENT_TOOLS);

    expect(resolved.tools).toHaveLength(3);
    expect(resolved.tools.map((t) => t.name)).toEqual(["file_read", "grep", "file_list"]);
  });

  it("filters to empty when no tools match", () => {
    const profile: SubagentProfile = {
      id: "test",
      name: "Test",
      description: "Test",
      systemPrompt: "Test",
      tools: ["non_existent_tool"],
    };

    const resolved = resolveProfile(profile, PARENT_PROMPT, PARENT_TOOLS);

    expect(resolved.tools).toHaveLength(0);
  });

  it("passes through model override", () => {
    const profile: SubagentProfile = {
      id: "fast",
      name: "Fast",
      description: "Fast agent",
      systemPrompt: "Be fast",
      model: "google/gemini-2.5-flash",
    };

    const resolved = resolveProfile(profile, PARENT_PROMPT, PARENT_TOOLS);

    expect(resolved.modelId).toBe("google/gemini-2.5-flash");
  });

  it("returns undefined modelId when no override", () => {
    const profile: SubagentProfile = {
      id: "default",
      name: "Default",
      description: "Default",
      systemPrompt: "Default",
    };

    const resolved = resolveProfile(profile, PARENT_PROMPT, PARENT_TOOLS);

    expect(resolved.modelId).toBeUndefined();
  });
});
