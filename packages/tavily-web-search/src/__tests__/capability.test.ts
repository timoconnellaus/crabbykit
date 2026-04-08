import { createNoopStorage } from "@claw-for-cloudflare/agent-runtime";
import { textOf } from "@claw-for-cloudflare/agent-runtime/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tavilyWebSearch } from "../capability.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("tavilyWebSearch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("returns a valid Capability with correct shape", () => {
    const cap = tavilyWebSearch({
      tavilyApiKey: "test-key",
    });

    expect(cap.id).toBe("tavily-web-search");
    expect(cap.name).toBe("Web Search (Tavily)");
    expect(cap.description).toBeTruthy();
    expect(cap.tools).toBeInstanceOf(Function);
    expect(cap.promptSections).toBeInstanceOf(Function);
  });

  it("provides web_search and web_fetch tools", () => {
    const cap = tavilyWebSearch({
      tavilyApiKey: "test-key",
    });

    const context = {
      agentId: "test-agent",
      sessionId: "s1",
      stepNumber: 0,
      emitCost: () => {},
      broadcast: () => {},
      broadcastToAll: () => {},
      broadcastState: () => {},
      requestFromClient: () => Promise.reject(new Error("Not available")),
      storage: createNoopStorage(),
      schedules: {} as any,
    };
    const tools = cap.tools!(context);

    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe("web_search");
    expect(tools[1].name).toBe("web_fetch");
  });

  it("returns prompt sections", () => {
    const cap = tavilyWebSearch({
      tavilyApiKey: "test-key",
    });

    const context = {
      agentId: "test-agent",
      sessionId: "s1",
      stepNumber: 0,
      emitCost: () => {},
      broadcast: () => {},
      broadcastToAll: () => {},
      broadcastState: () => {},
      requestFromClient: () => Promise.reject(new Error("Not available")),
      storage: createNoopStorage(),
      schedules: {} as any,
    };
    const sections = cap.promptSections!(context);

    expect(sections).toHaveLength(1);
    expect(sections[0]).toContain("web search");
  });

  it("accepts API key as a function", () => {
    const cap = tavilyWebSearch({
      tavilyApiKey: () => "dynamic-key",
    });

    const tools = cap.tools!({
      agentId: "test-agent",
      sessionId: "s1",
      stepNumber: 0,
      emitCost: () => {},
      broadcast: () => {},
      broadcastToAll: () => {},
      broadcastState: () => {},
      requestFromClient: () => Promise.reject(new Error("Not available")),
      storage: createNoopStorage(),
      schedules: {} as any,
    });
    expect(tools).toHaveLength(2);
  });

  it("accepts custom configuration", () => {
    const cap = tavilyWebSearch({
      tavilyApiKey: "key",
      maxResults: 10,
      userAgent: "CustomBot/3.0",
      maxFetchSize: 100_000,
    });

    expect(cap.id).toBe("tavily-web-search");
    const tools = cap.tools!({
      agentId: "test-agent",
      sessionId: "s1",
      stepNumber: 0,
      emitCost: () => {},
      broadcast: () => {},
      broadcastToAll: () => {},
      broadcastState: () => {},
      requestFromClient: () => Promise.reject(new Error("Not available")),
      storage: createNoopStorage(),
      schedules: {} as any,
    });
    expect(tools).toHaveLength(2);
  });

  it("has no lifecycle hooks", () => {
    const cap = tavilyWebSearch({ tavilyApiKey: "key" });
    expect(cap.hooks).toBeUndefined();
  });

  it("string API key is resolved when tool executes", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const cap = tavilyWebSearch({ tavilyApiKey: "my-string-key" });
    const context = {
      agentId: "test-agent",
      sessionId: "s1",
      stepNumber: 0,
      emitCost: vi.fn(),
      broadcast: () => {},
      broadcastToAll: () => {},
      broadcastState: () => {},
      requestFromClient: () => Promise.reject(new Error("Not available")),
      storage: createNoopStorage(),
      schedules: {} as any,
    };
    const tools = cap.tools!(context);
    const searchTool = tools[0];

    await searchTool.execute({ query: "test" }, { toolCallId: "test" });

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.api_key).toBe("my-string-key");
  });

  it("passes searchDefaults to the search tool", async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ results: [{ title: "R", url: "https://r.com", content: "C" }] }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const cap = tavilyWebSearch({
      tavilyApiKey: "key",
      searchDefaults: { searchDepth: "advanced" },
    });
    const context = {
      agentId: "test-agent",
      sessionId: "s1",
      stepNumber: 0,
      emitCost: vi.fn(),
      broadcast: () => {},
      broadcastToAll: () => {},
      broadcastState: () => {},
      requestFromClient: () => Promise.reject(new Error("Not available")),
      storage: createNoopStorage(),
      schedules: {} as any,
    };
    const tools = cap.tools!(context);
    await tools[0].execute({ query: "test" }, { toolCallId: "test" });

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.search_depth).toBe("advanced");
  });
});
