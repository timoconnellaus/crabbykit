import { describe, expect, it } from "vitest";
import { resolveSubagentSpawn } from "../resolve.js";
import type { Mode } from "../types.js";

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
const PARENT_TOOLS: any[] = [
  mockTool("file_read"),
  mockTool("file_write"),
  mockTool("file_edit"),
  mockTool("grep"),
  mockTool("file_list"),
  mockTool("tavily_search"),
];

describe("resolveSubagentSpawn", () => {
  it("resolves static systemPromptOverride", () => {
    const mode: Mode = {
      id: "test",
      name: "Test",
      description: "Test agent",
      systemPromptOverride: "Custom prompt",
    };

    const resolved = resolveSubagentSpawn(mode, PARENT_PROMPT, PARENT_TOOLS);

    expect(resolved.systemPrompt).toBe("Custom prompt");
    expect(resolved.mode).toBe(mode);
  });

  it("resolves function systemPromptOverride with parent prompt", () => {
    const mode: Mode = {
      id: "test",
      name: "Test",
      description: "Test agent",
      systemPromptOverride: (base) => `${base}\n\nAdditional instructions.`,
    };

    const resolved = resolveSubagentSpawn(mode, PARENT_PROMPT, PARENT_TOOLS);

    expect(resolved.systemPrompt).toBe("You are a helpful agent.\n\nAdditional instructions.");
  });

  it("inherits the parent prompt when systemPromptOverride is absent", () => {
    const mode: Mode = {
      id: "test",
      name: "Test",
      description: "Test agent",
    };

    const resolved = resolveSubagentSpawn(mode, PARENT_PROMPT, PARENT_TOOLS);

    expect(resolved.systemPrompt).toBe(PARENT_PROMPT);
  });

  it("inherits all parent tools when no filter", () => {
    const mode: Mode = {
      id: "test",
      name: "Test",
      description: "Test agent",
    };

    const resolved = resolveSubagentSpawn(mode, PARENT_PROMPT, PARENT_TOOLS);

    expect(resolved.tools).toHaveLength(PARENT_TOOLS.length);
    expect(resolved.tools.map((t) => t.name)).toEqual(PARENT_TOOLS.map((t) => t.name));
  });

  it("filters tools by allow list", () => {
    const mode: Mode = {
      id: "explorer",
      name: "Explorer",
      description: "Read-only explorer",
      tools: { allow: ["file_read", "grep", "file_list"] },
    };

    const resolved = resolveSubagentSpawn(mode, PARENT_PROMPT, PARENT_TOOLS);

    expect(resolved.tools).toHaveLength(3);
    expect(resolved.tools.map((t) => t.name)).toEqual(["file_read", "grep", "file_list"]);
  });

  it("filters to empty when no tools match allow list", () => {
    const mode: Mode = {
      id: "test",
      name: "Test",
      description: "Test",
      tools: { allow: ["non_existent_tool"] },
    };

    const resolved = resolveSubagentSpawn(mode, PARENT_PROMPT, PARENT_TOOLS);

    expect(resolved.tools).toHaveLength(0);
  });

  it("filters tools by deny list", () => {
    const mode: Mode = {
      id: "safe",
      name: "Safe",
      description: "No writes",
      tools: { deny: ["file_write", "file_edit"] },
    };

    const resolved = resolveSubagentSpawn(mode, PARENT_PROMPT, PARENT_TOOLS);

    expect(resolved.tools.map((t) => t.name)).toEqual([
      "file_read",
      "grep",
      "file_list",
      "tavily_search",
    ]);
  });

  it("passes through model override", () => {
    const mode: Mode = {
      id: "fast",
      name: "Fast",
      description: "Fast agent",
      model: "google/gemini-2.5-flash",
    };

    const resolved = resolveSubagentSpawn(mode, PARENT_PROMPT, PARENT_TOOLS);

    expect(resolved.modelId).toBe("google/gemini-2.5-flash");
  });

  it("returns undefined modelId when no override", () => {
    const mode: Mode = {
      id: "default",
      name: "Default",
      description: "Default",
    };

    const resolved = resolveSubagentSpawn(mode, PARENT_PROMPT, PARENT_TOOLS);

    expect(resolved.modelId).toBeUndefined();
  });
});
