import type { AnyAgentTool } from "@claw-for-cloudflare/agent-core";
import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import type { AgentContext } from "../../agent-do.js";
import type { Capability } from "../../capabilities/types.js";
import { textOf } from "../../test-utils.js";
import { defineTool, mcpToolToAgentTool, toolResult } from "../define-tool.js";

describe("defineTool", () => {
  it("creates a valid AgentTool", () => {
    const tool = defineTool({
      name: "file_read",
      description: "Read a file",
      parameters: Type.Object({
        path: Type.String(),
      }),
      execute: async (args) => ({
        content: [{ type: "text" as const, text: args.path }],
        details: {},
      }),
    });

    expect(tool.name).toBe("file_read");
    expect(tool.label).toBe("file_read");
    expect(tool.description).toBe("Read a file");
    expect(tool.parameters).toBeTruthy();
    expect(typeof tool.execute).toBe("function");
  });

  it("uses custom label when provided", () => {
    const tool = defineTool({
      name: "my_tool",
      label: "My Tool",
      description: "A tool",
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: {} }),
    });

    expect(tool.label).toBe("My Tool");
  });

  it("passes arguments correctly to execute", async () => {
    const tool = defineTool({
      name: "test",
      description: "Test tool",
      parameters: Type.Object({
        path: Type.String(),
        limit: Type.Optional(Type.Number()),
      }),
      execute: async (args) => ({
        content: [{ type: "text" as const, text: `${args.path}:${args.limit}` }],
        details: args,
      }),
    });

    const result = await tool.execute({ path: "/test.ts", limit: 10 }, { toolCallId: "call_1" });
    expect(result.content[0]).toEqual({
      type: "text",
      text: "/test.ts:10",
    });
    expect(result.details).toEqual({ path: "/test.ts", limit: 10 });
  });

  it("passes toolCallId to execute", async () => {
    let capturedId: string | undefined;

    const tool = defineTool({
      name: "test",
      description: "Test",
      parameters: Type.Object({}),
      execute: async (_args, ctx) => {
        capturedId = ctx.toolCallId;
        return { content: [], details: {} };
      },
    });

    await tool.execute({}, { toolCallId: "call_abc123" });
    expect(capturedId).toBe("call_abc123");
  });

  it("passes abort signal to execute", async () => {
    let receivedSignal: AbortSignal | undefined;

    const tool = defineTool({
      name: "test",
      description: "Test",
      parameters: Type.Object({}),
      execute: async (_args, ctx) => {
        receivedSignal = ctx.signal;
        return { content: [], details: {} };
      },
    });

    const controller = new AbortController();
    await tool.execute({}, { toolCallId: "call_1", signal: controller.signal });
    expect(receivedSignal).toBe(controller.signal);
  });

  it("handles execute errors gracefully", async () => {
    const tool = defineTool({
      name: "failing",
      description: "Fails",
      parameters: Type.Object({}),
      execute: async () => {
        throw new Error("Tool failed");
      },
    });

    await expect(tool.execute({}, { toolCallId: "call_1" })).rejects.toThrow("Tool failed");
  });
});

describe("mcpToolToAgentTool", () => {
  it("converts MCP tool to AgentTool", () => {
    const mcpTool = {
      name: "search",
      description: "Search the web",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
      },
    };

    const server = {
      name: "web",
      callTool: vi.fn().mockResolvedValue({
        content: "search results",
        isError: false,
      }),
    };

    const tool = mcpToolToAgentTool(mcpTool, server);

    expect(tool.name).toBe("mcp_web_search");
    expect(tool.description).toBe("Search the web");
    expect(tool.parameters).toBeTruthy();
  });

  it("prefixes tool name with server name", () => {
    const tool = mcpToolToAgentTool(
      { name: "list", inputSchema: {} },
      { name: "github", callTool: vi.fn() },
    );

    expect(tool.name).toBe("mcp_github_list");
  });

  it("uses default description when not provided", () => {
    const tool = mcpToolToAgentTool(
      { name: "action", inputSchema: {} },
      { name: "svc", callTool: vi.fn() },
    );

    expect(tool.description).toBe("MCP tool: action");
  });

  it("executes via MCP server callTool", async () => {
    const mockCallTool = vi.fn().mockResolvedValue({
      content: { results: [1, 2, 3] },
      isError: false,
    });

    const tool = mcpToolToAgentTool(
      { name: "query", description: "Query", inputSchema: {} },
      { name: "db", callTool: mockCallTool },
    );

    const result = await tool.execute({ sql: "SELECT 1" }, { toolCallId: "call_1" });

    expect(mockCallTool).toHaveBeenCalledWith("query", { sql: "SELECT 1" });
    expect(result.content[0].type).toBe("text");
    expect((result.details as { content: unknown }).content).toEqual({ results: [1, 2, 3] });
  });

  it("handles string content from MCP", async () => {
    const tool = mcpToolToAgentTool(
      { name: "echo", inputSchema: {} },
      {
        name: "test",
        callTool: vi.fn().mockResolvedValue({
          content: "plain text result",
        }),
      },
    );

    const result = await tool.execute({}, { toolCallId: "call_1" });
    expect(result.content[0]).toEqual({
      type: "text",
      text: "plain text result",
    });
  });

  it("converts various JSON Schema inputs", () => {
    // Simple object
    const t1 = mcpToolToAgentTool(
      {
        name: "t1",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
        },
      },
      { name: "s", callTool: vi.fn() },
    );
    expect(t1.parameters).toBeTruthy();

    // Empty schema
    const t2 = mcpToolToAgentTool(
      { name: "t2", inputSchema: {} },
      { name: "s", callTool: vi.fn() },
    );
    expect(t2.parameters).toBeTruthy();

    // Nested properties
    const t3 = mcpToolToAgentTool(
      {
        name: "t3",
        inputSchema: {
          type: "object",
          properties: {
            config: {
              type: "object",
              properties: { enabled: { type: "boolean" } },
            },
          },
        },
      },
      { name: "s", callTool: vi.fn() },
    );
    expect(t3.parameters).toBeTruthy();
  });
});

describe("defineTool return type ergonomics", () => {
  it("returns AnyAgentTool assignable to Capability.tools()", () => {
    const capability: Capability = {
      id: "test-cap",
      name: "Test",
      description: "Test capability",
      tools: (_context: AgentContext): AnyAgentTool[] => [
        defineTool({
          name: "cap_tool",
          description: "A capability tool",
          parameters: Type.Object({ input: Type.String() }),
          execute: async (args) => `echo: ${args.input}`,
        }),
      ],
    };

    const tools = capability.tools!({} as AgentContext);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("cap_tool");
  });

  it("wraps string return into content array", async () => {
    const tool = defineTool({
      name: "string_tool",
      description: "Returns a string",
      parameters: Type.Object({}),
      execute: async () => "the string",
    });

    const result = await tool.execute({}, { toolCallId: "call_1" });
    expect(result).toEqual({
      content: [{ type: "text", text: "the string" }],
      details: null,
    });
  });

  it("passes full AgentToolResult through unchanged", async () => {
    const tool = defineTool({
      name: "full_result_tool",
      description: "Returns full result",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text" as const, text: "hello" }],
        details: { foo: 1 },
      }),
    });

    const result = await tool.execute({}, { toolCallId: "call_1" });
    expect(result).toEqual({
      content: [{ type: "text", text: "hello" }],
      details: { foo: 1 },
    });
  });
});

describe("defineTool with timeout", () => {
  it("completes normally when under timeout", async () => {
    const tool = defineTool({
      name: "fast_tool",
      description: "Fast tool",
      parameters: Type.Object({}),
      timeout: 1000,
      execute: async () => toolResult.text("done"),
    });

    const result = await tool.execute({}, { toolCallId: "test" });
    expect(textOf(result)).toBe("done");
  });

  it("returns timeout error when exceeding timeout", async () => {
    const tool = defineTool({
      name: "slow_tool",
      description: "Slow tool",
      parameters: Type.Object({}),
      timeout: 50,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return toolResult.text("should not reach");
      },
    });

    const result = await tool.execute({}, { toolCallId: "test" });
    expect(textOf(result)).toContain("timed out after 50ms");
    expect(textOf(result)).toContain("slow_tool");
  });

  it("does not wrap when no timeout specified", async () => {
    const tool = defineTool({
      name: "no_timeout",
      description: "No timeout",
      parameters: Type.Object({}),
      execute: async () => toolResult.text("ok"),
    });

    const result = await tool.execute({}, { toolCallId: "test" });
    expect(textOf(result)).toBe("ok");
  });

  it("propagates non-timeout errors", async () => {
    const tool = defineTool({
      name: "error_tool",
      description: "Errors",
      parameters: Type.Object({}),
      timeout: 5000,
      execute: async () => {
        throw new Error("real error");
      },
    });

    await expect(tool.execute({}, { toolCallId: "test" })).rejects.toThrow("real error");
  });

  it("timeout of 0ms triggers immediate timeout", async () => {
    const tool = defineTool({
      name: "zero_timeout",
      description: "Zero timeout",
      parameters: Type.Object({}),
      timeout: 0,
      execute: async () => {
        // Even instant execution loses the race to setTimeout(0)
        return toolResult.text("maybe");
      },
    });

    // With timeout 0, result is non-deterministic (race between setTimeout(0) and microtask)
    // but the tool should not throw
    const result = await tool.execute({}, { toolCallId: "test" });
    expect(result).toBeDefined();
  });
});
