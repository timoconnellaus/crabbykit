import type { AnyAgentTool } from "@claw-for-cloudflare/agent-core";
import { describe, expect, it } from "vitest";
import type { PromptSection } from "../../prompt/types.js";
import { defineMode } from "../define-mode.js";
import { filterToolsAndSections } from "../filter-tools-and-sections.js";

function tool(name: string): AnyAgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: {},
    execute: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
  } as unknown as AnyAgentTool;
}

function capSection(capabilityId: string, key: string): PromptSection {
  return {
    name: capabilityId,
    key,
    content: "section",
    lines: 1,
    tokens: 1,
    source: { type: "capability", capabilityId, capabilityName: capabilityId },
    included: true,
  };
}

function defaultSection(id: "identity" | "safety" | "runtime"): PromptSection {
  return {
    name: id,
    key: id,
    content: id,
    lines: 1,
    tokens: 1,
    source: { type: "default", id },
    included: true,
  };
}

describe("filterToolsAndSections", () => {
  it("null mode passes through tools and sections unchanged", () => {
    const tools = [tool("a"), tool("b")];
    const sections = [defaultSection("identity"), capSection("r2", "cap-r2-1")];
    const result = filterToolsAndSections(tools, sections, null);
    expect(result.tools).toBe(tools);
    expect(result.sections).toBe(sections);
  });

  it("applies tool allow filter", () => {
    const tools = [tool("file_read"), tool("file_write"), tool("grep")];
    const mode = defineMode({
      id: "p",
      name: "p",
      description: "p",
      tools: { allow: ["file_read", "grep"] },
    });
    const result = filterToolsAndSections(tools, [], mode);
    expect(result.tools.map((t) => t.name)).toEqual(["file_read", "grep"]);
  });

  it("applies tool deny filter", () => {
    const tools = [tool("file_read"), tool("file_write"), tool("file_delete")];
    const mode = defineMode({
      id: "p",
      name: "p",
      description: "p",
      tools: { deny: ["file_write", "file_delete"] },
    });
    const result = filterToolsAndSections(tools, [], mode);
    expect(result.tools.map((t) => t.name)).toEqual(["file_read"]);
  });

  it("flips capability-sourced sections to excluded with mode-id reason", () => {
    const sections = [defaultSection("identity"), capSection("vibe-coder", "cap-vibe-1")];
    const mode = defineMode({
      id: "plan",
      name: "Plan",
      description: "p",
      capabilities: { deny: ["vibe-coder"] },
    });
    const result = filterToolsAndSections([], sections, mode);
    const flipped = result.sections.find((s) => s.key === "cap-vibe-1");
    expect(flipped?.included).toBe(false);
    expect(flipped?.content).toBe("");
    expect(flipped?.lines).toBe(0);
    expect(flipped?.tokens).toBe(0);
    expect(flipped?.excludedReason).toBe("Filtered by mode: plan");
  });

  it("leaves non-capability sections untouched", () => {
    const sections = [defaultSection("identity"), defaultSection("safety")];
    const mode = defineMode({
      id: "x",
      name: "x",
      description: "x",
      capabilities: { deny: ["anything"] },
    });
    const result = filterToolsAndSections([], sections, mode);
    expect(result.sections).toEqual(sections);
  });

  it("preserves already-excluded sections", () => {
    const excluded: PromptSection = {
      name: "cap",
      key: "cap-x-1",
      content: "",
      lines: 0,
      tokens: 0,
      source: { type: "capability", capabilityId: "x", capabilityName: "X" },
      included: false,
      excludedReason: "Pre-existing reason",
    };
    const mode = defineMode({
      id: "m",
      name: "m",
      description: "m",
      capabilities: { deny: ["x"] },
    });
    const result = filterToolsAndSections([], [excluded], mode);
    expect(result.sections[0]).toBe(excluded);
  });
});
