import type { AgentContext } from "@claw-for-cloudflare/agent-runtime";
import { createNoopStorage } from "@claw-for-cloudflare/agent-runtime";
import { textOf } from "@claw-for-cloudflare/agent-runtime/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSearchTool } from "../search.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockContext(): AgentContext {
  return {
    agentId: "test-agent",
    sessionId: "test-session",
    stepNumber: 0,
    emitCost: vi.fn(),
    broadcast: () => {},
    broadcastToAll: () => {},
    broadcastState: () => {},
    requestFromClient: () => Promise.reject(new Error("Not available")),
    storage: createNoopStorage(),
    schedules: {} as any,
    rateLimit: { consume: async () => ({ allowed: true }) },
  notifyBundlePointerChanged: async () => {},
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
          search_depth: "basic",
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

  it("handles non-Error thrown objects in catch", async () => {
    mockFetch.mockRejectedValue("raw string error");

    const ctx = mockContext();
    const tool = createSearchTool(() => "key", 5, ctx);
    const result = await tool.execute({ query: "test" }, { toolCallId: "test" });

    expect(textOf(result)).toContain("raw string error");
    expect(ctx.emitCost).not.toHaveBeenCalled();
  });

  it("uses search defaults when per-call params are omitted", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        results: [{ title: "R", url: "https://r.com", content: "C" }],
      }),
    );

    const ctx = mockContext();
    const tool = createSearchTool(() => "key", 5, ctx, {
      searchDepth: "advanced",
      includeDomains: ["example.com"],
      excludeDomains: ["spam.com"],
    });
    await tool.execute({ query: "test" }, { toolCallId: "test" });

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.search_depth).toBe("advanced");
    expect(body.include_domains).toEqual(["example.com"]);
    expect(body.exclude_domains).toEqual(["spam.com"]);
  });

  it("per-call params override search defaults", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        results: [{ title: "R", url: "https://r.com", content: "C" }],
      }),
    );

    const ctx = mockContext();
    const tool = createSearchTool(() => "key", 5, ctx, {
      searchDepth: "basic",
      includeDomains: ["default.com"],
      excludeDomains: ["default-exclude.com"],
    });
    await tool.execute(
      {
        query: "test",
        search_depth: "advanced",
        include_domains: ["override.com"],
        exclude_domains: ["override-exclude.com"],
      },
      { toolCallId: "test" },
    );

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.search_depth).toBe("advanced");
    expect(body.include_domains).toEqual(["override.com"]);
    expect(body.exclude_domains).toEqual(["override-exclude.com"]);
  });

  it("handles null results in response", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ results: null }));

    const ctx = mockContext();
    const tool = createSearchTool(() => "key", 5, ctx);
    const result = await tool.execute({ query: "test" }, { toolCallId: "test" });

    expect(textOf(result)).toBe("No results found.");
    expect(ctx.emitCost).not.toHaveBeenCalled();
  });

  it("handles error.text() failure on non-ok response", async () => {
    const badResponse = new Response(null, { status: 500 });
    // Override text() to throw
    badResponse.text = () => Promise.reject(new Error("body consumed"));
    mockFetch.mockResolvedValue(badResponse);

    const ctx = mockContext();
    const tool = createSearchTool(() => "key", 5, ctx);
    const result = await tool.execute({ query: "test" }, { toolCallId: "test" });

    expect(textOf(result)).toContain("500");
    expect(textOf(result)).toContain("Unknown error");
  });
});
