import type { AgentTool } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import type { AgentContext } from "../../agent-do.js";
import { resolveCapabilities } from "../resolve.js";
import type { Capability } from "../types.js";

const ctx: AgentContext = { sessionId: "s1", stepNumber: 0 };

function makeTool(name: string): AgentTool {
  return {
    name,
    description: `Tool ${name}`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: null }),
  } as unknown as AgentTool;
}

function makeCap(overrides: Partial<Capability> & { id: string }): Capability {
  return {
    name: overrides.id,
    description: `Capability ${overrides.id}`,
    ...overrides,
  };
}

describe("resolveCapabilities", () => {
  it("returns empty result for empty capabilities array", () => {
    const result = resolveCapabilities([], ctx);

    expect(result.tools).toEqual([]);
    expect(result.promptSections).toEqual([]);
    expect(result.mcpServers).toEqual([]);
    expect(result.beforeInferenceHooks).toEqual([]);
  });

  it("resolves tools from a single capability", () => {
    const tool = makeTool("search");
    const cap = makeCap({
      id: "web-search",
      tools: () => [tool],
    });

    const result = resolveCapabilities([cap], ctx);

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("search");
  });

  it("resolves prompt sections from a single capability", () => {
    const cap = makeCap({
      id: "memory",
      promptSections: () => ["You have access to memory.", "Use it wisely."],
    });

    const result = resolveCapabilities([cap], ctx);

    expect(result.promptSections).toEqual(["You have access to memory.", "Use it wisely."]);
  });

  it("resolves MCP servers from a single capability", () => {
    const cap = makeCap({
      id: "mcp-test",
      mcpServers: [{ id: "srv1", name: "Test Server", url: "http://localhost:3000" } as any],
    });

    const result = resolveCapabilities([cap], ctx);

    expect(result.mcpServers).toHaveLength(1);
    expect(result.mcpServers[0].name).toBe("Test Server");
  });

  it("collects beforeInference hooks", () => {
    const hook = async (msgs: any[]) => msgs;
    const cap = makeCap({
      id: "compaction",
      hooks: { beforeInference: hook },
    });

    const result = resolveCapabilities([cap], ctx);

    expect(result.beforeInferenceHooks).toHaveLength(1);
    expect(result.beforeInferenceHooks[0]).toBe(hook);
  });

  it("merges multiple capabilities in registration order", () => {
    const cap1 = makeCap({
      id: "cap-a",
      tools: () => [makeTool("tool_a")],
      promptSections: () => ["Section A"],
    });
    const cap2 = makeCap({
      id: "cap-b",
      tools: () => [makeTool("tool_b")],
      promptSections: () => ["Section B"],
    });

    const result = resolveCapabilities([cap1, cap2], ctx);

    expect(result.tools.map((t) => t.name)).toEqual(["tool_a", "tool_b"]);
    expect(result.promptSections).toEqual(["Section A", "Section B"]);
  });

  it("preserves hook execution order matching registration order", () => {
    const order: string[] = [];
    const hook1 = async (msgs: any[]) => {
      order.push("first");
      return msgs;
    };
    const hook2 = async (msgs: any[]) => {
      order.push("second");
      return msgs;
    };

    const cap1 = makeCap({ id: "a", hooks: { beforeInference: hook1 } });
    const cap2 = makeCap({ id: "b", hooks: { beforeInference: hook2 } });

    const result = resolveCapabilities([cap1, cap2], ctx);

    expect(result.beforeInferenceHooks[0]).toBe(hook1);
    expect(result.beforeInferenceHooks[1]).toBe(hook2);
  });

  it("warns and skips duplicate tool names", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cap1 = makeCap({
      id: "cap-a",
      tools: () => [makeTool("shared_name")],
    });
    const cap2 = makeCap({
      id: "cap-b",
      tools: () => [makeTool("shared_name")],
    });

    const result = resolveCapabilities([cap1, cap2], ctx);

    expect(result.tools).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Duplicate tool name "shared_name"'),
    );

    warnSpy.mockRestore();
  });

  it("handles capability with no optional fields", () => {
    const cap = makeCap({ id: "bare-minimum" });
    const result = resolveCapabilities([cap], ctx);

    expect(result.tools).toEqual([]);
    expect(result.promptSections).toEqual([]);
    expect(result.mcpServers).toEqual([]);
    expect(result.beforeInferenceHooks).toEqual([]);
  });

  it("passes context to tools and promptSections factories", () => {
    const toolsFn = vi.fn(() => [makeTool("t1")]);
    const promptFn = vi.fn(() => ["prompt"]);

    const cap = makeCap({
      id: "ctx-test",
      tools: toolsFn,
      promptSections: promptFn,
    });

    resolveCapabilities([cap], ctx);

    expect(toolsFn).toHaveBeenCalledWith(ctx);
    expect(promptFn).toHaveBeenCalledWith(ctx);
  });
});
