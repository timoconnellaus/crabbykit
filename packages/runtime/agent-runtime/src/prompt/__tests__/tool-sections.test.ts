import type { AgentTool } from "@crabbykit/agent-core";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { buildToolPromptSections } from "../tool-sections.js";

// biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
function makeTool(name: string, description?: string, guidance?: string): AgentTool<any> {
  return {
    name,
    description: description ?? "",
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details: null }),
    ...(guidance !== undefined ? { guidance } : {}),
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
  } as any;
}

describe("buildToolPromptSections", () => {
  it("returns no sections when tools list is empty", () => {
    expect(buildToolPromptSections([])).toEqual([]);
  });

  it("builds a Tools section listing each tool with description", () => {
    const sections = buildToolPromptSections([
      makeTool("search", "search the web"),
      makeTool("fetch", "fetch a URL"),
    ]);
    expect(sections).toHaveLength(1);
    const [list] = sections;
    expect(list.name).toBe("Tools");
    expect(list.key).toBe("auto-tools");
    expect(list.source).toEqual({ type: "tools" });
    expect(list.included).toBe(true);
    expect(list.content).toContain("- **search**: search the web");
    expect(list.content).toContain("- **fetch**: fetch a URL");
    expect(list.tokens).toBeGreaterThan(0);
    expect(list.lines).toBeGreaterThan(0);
  });

  it("omits the description colon for tools with no description", () => {
    const sections = buildToolPromptSections([makeTool("raw")]);
    expect(sections[0].content).toContain("- **raw**");
    expect(sections[0].content).not.toContain("- **raw**:");
  });

  it("adds a Tool Guidance section only when guidance differs from description", () => {
    const tools = [
      makeTool("same", "same text", "same text"), // guidance == description → no entry
      makeTool("bare", "only description"), // no guidance → no entry
      makeTool("unique", "short desc", "long behavioral guidance"),
    ];
    const sections = buildToolPromptSections(tools);
    expect(sections).toHaveLength(2);
    const guidance = sections[1];
    expect(guidance.name).toBe("Tool Guidance");
    expect(guidance.key).toBe("auto-tool-guidance");
    expect(guidance.source).toEqual({ type: "tool-guidance" });
    expect(guidance.content).toContain("### unique");
    expect(guidance.content).toContain("long behavioral guidance");
    expect(guidance.content).not.toContain("### same");
    expect(guidance.content).not.toContain("### bare");
  });
});
