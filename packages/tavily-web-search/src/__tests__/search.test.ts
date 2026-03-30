import type { AgentContext } from "@claw-for-cloudflare/agent-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSearchTool } from "../search.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

/** Extract text from the first content block of a tool result */
function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content[0] as { type: "text"; text: string };
  return block.text;
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockContext(): AgentContext {
  return {
    sessionId: "test-session",
    stepNumber: 0,
    emitCost: vi.fn(),
    broadcast: () => {},
    broadcastToAll: () => {},
    requestFromClient: () => Promise.reject(new Error("Not available")),
    schedules: {} as any,
  };
}

describe("createSearchTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a tool with correct name and description", () => {
    const tool = createSearchTool(() => "key", 5, mockContext());
    expect(tool.name).toBe("web_search");
    expect(tool.description).toBeTruthy();
  });

  it("returns error when API key is missing", async () => {
    const ctx = mockContext();
    const tool = createSearchTool(() => "", 5, ctx);
    const result = await tool.execute({ query: "test" }, { toolCallId: "test" });

    expect(textOf(result)).toContain("not configured");
    expect(mockFetch).not.toHaveBeenCalled();
    expect(ctx.emitCost).not.toHaveBeenCalled();
  });

  it("calls Tavily API with correct parameters", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        results: [{ title: "Result 1", url: "https://example.com", content: "Content 1" }],
      }),
    );

    const tool = createSearchTool(() => "test-key", 3, mockContext());
    await tool.execute({ query: "cloudflare workers" }, { toolCallId: "test" });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.tavily.com/search",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          api_key: "test-key",
          query: "cloudflare workers",
          max_results: 3,
        }),
      }),
    );
  });

  it("formats results as numbered list and emits cost", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        results: [
          { title: "First", url: "https://a.com", content: "Content A" },
          { title: "Second", url: "https://b.com", content: "Content B" },
        ],
      }),
    );

    const ctx = mockContext();
    const tool = createSearchTool(() => "key", 5, ctx);
    const result = await tool.execute({ query: "test" }, { toolCallId: "test" });
    const text = textOf(result);

    expect(text).toContain("1. **First**");
    expect(text).toContain("https://a.com");
    expect(text).toContain("Content A");
    expect(text).toContain("2. **Second**");
    expect(ctx.emitCost).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityId: "tavily-web-search",
        toolName: "web_search",
        amount: 0.01,
        currency: "USD",
      }),
    );
  });

  it("handles empty results without emitting cost", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ results: [] }));

    const ctx = mockContext();
    const tool = createSearchTool(() => "key", 5, ctx);
    const result = await tool.execute({ query: "test" }, { toolCallId: "test" });

    expect(textOf(result)).toBe("No results found.");
    expect(ctx.emitCost).not.toHaveBeenCalled();
  });

  it("handles API error response without emitting cost", async () => {
    mockFetch.mockResolvedValue(new Response("Rate limited", { status: 429 }));

    const ctx = mockContext();
    const tool = createSearchTool(() => "key", 5, ctx);
    const result = await tool.execute({ query: "test" }, { toolCallId: "test" });

    expect(textOf(result)).toContain("429");
    expect(textOf(result)).toContain("Rate limited");
    expect(ctx.emitCost).not.toHaveBeenCalled();
  });

  it("handles network error without emitting cost", async () => {
    mockFetch.mockRejectedValue(new Error("DNS resolution failed"));

    const ctx = mockContext();
    const tool = createSearchTool(() => "key", 5, ctx);
    const result = await tool.execute({ query: "test" }, { toolCallId: "test" });

    expect(textOf(result)).toContain("DNS resolution failed");
    expect(ctx.emitCost).not.toHaveBeenCalled();
  });
});
