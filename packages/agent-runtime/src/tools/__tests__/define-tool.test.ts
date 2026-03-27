import { describe, it, expect, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { defineTool, mcpToolToAgentTool } from "../define-tool.js";

describe("defineTool", () => {
  it("creates a valid AgentTool", () => {
    const tool = defineTool({
      name: "file_read",
      description: "Read a file",
      parameters: Type.Object({
        path: Type.String(),
      }),
      execute: async (_id, args) => ({
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
      execute: async (_id, args) => ({
        content: [
          { type: "text" as const, text: `${args.path}:${args.limit}` },
        ],
        details: args,
      }),
    });

    const result = await tool.execute(
      "call_1",
      { path: "/test.ts", limit: 10 },
    );
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
      execute: async (id) => {
        capturedId = id;
        return { content: [], details: {} };
      },
    });

    await tool.execute("call_abc123", {});
    expect(capturedId).toBe("call_abc123");
  });

  it("passes abort signal to execute", async () => {
    let receivedSignal: AbortSignal | undefined;

    const tool = defineTool({
      name: "test",
      description: "Test",
      parameters: Type.Object({}),
      execute: async (_id, _args, signal) => {
        receivedSignal = signal;
        return { content: [], details: {} };
      },
    });

    const controller = new AbortController();
    await tool.execute("call_1", {}, controller.signal);
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

    await expect(tool.execute("call_1", {})).rejects.toThrow("Tool failed");
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

    const result = await tool.execute("call_1", { sql: "SELECT 1" });

    expect(mockCallTool).toHaveBeenCalledWith("query", { sql: "SELECT 1" });
    expect(result.content[0].type).toBe("text");
    expect(result.details.content).toEqual({ results: [1, 2, 3] });
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

    const result = await tool.execute("call_1", {});
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
