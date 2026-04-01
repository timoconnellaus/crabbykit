import type { AgentContext } from "@claw-for-cloudflare/agent-runtime";
import { textOf } from "@claw-for-cloudflare/agent-runtime/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFetchTool, stripHtml } from "../fetch.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function mockContext(): AgentContext {
  return {
    agentId: "test-agent",
    sessionId: "test-session",
    stepNumber: 0,
    emitCost: vi.fn(),
    broadcast: () => {},
    broadcastToAll: () => {},
    requestFromClient: () => Promise.reject(new Error("Not available")),
    schedules: {} as any,
  };
}

function htmlResponse(html: string, status = 200) {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html" },
  });
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("stripHtml", () => {
  it("removes script tags and contents", () => {
    expect(stripHtml("<script>alert('xss')</script>Hello")).toBe("Hello");
  });

  it("removes style tags and contents", () => {
    expect(stripHtml("<style>body{color:red}</style>Hello")).toBe("Hello");
  });

  it("removes HTML tags", () => {
    expect(stripHtml("<p>Hello <b>world</b></p>")).toBe("Hello world");
  });

  it("unescapes HTML entities", () => {
    expect(stripHtml("&amp; &lt; &gt; &quot; &#39; &nbsp;")).toBe("& < > \" '");
  });

  it("normalizes whitespace", () => {
    expect(stripHtml("  Hello   \n\n  world  ")).toBe("Hello world");
  });
});

describe("createFetchTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a tool with correct name", () => {
    const tool = createFetchTool(undefined, undefined, mockContext());
    expect(tool.name).toBe("web_fetch");
  });

  it("returns error for invalid URL", async () => {
    const tool = createFetchTool(undefined, undefined, mockContext());
    const result = await tool.execute({ url: "not-a-url" }, { toolCallId: "test" });

    expect(textOf(result)).toContain("Invalid URL");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("strips HTML from HTML responses", async () => {
    mockFetch.mockResolvedValue(
      htmlResponse("<html><body><h1>Title</h1><p>Content</p></body></html>"),
    );

    const tool = createFetchTool(undefined, undefined, mockContext());
    const result = await tool.execute({ url: "https://example.com" }, { toolCallId: "test" });

    expect(textOf(result)).toBe("Title Content");
  });

  it("pretty-prints JSON responses", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ key: "value" }));

    const tool = createFetchTool(undefined, undefined, mockContext());
    const result = await tool.execute(
      { url: "https://api.example.com/data" },
      { toolCallId: "test" },
    );

    expect(textOf(result)).toBe('{\n  "key": "value"\n}');
  });

  it("truncates content exceeding maxSize", async () => {
    const longContent = "x".repeat(100_000);
    mockFetch.mockResolvedValue(
      new Response(longContent, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    const tool = createFetchTool("TestAgent/1.0", 50_000, mockContext());
    const result = await tool.execute({ url: "https://example.com/large" }, { toolCallId: "test" });
    const text = textOf(result);

    expect(text.length).toBeLessThan(100_000);
    expect(text).toContain("[Content truncated");
  });

  it("sends custom User-Agent header", async () => {
    mockFetch.mockResolvedValue(
      new Response("ok", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    const tool = createFetchTool("MyBot/2.0", undefined, mockContext());
    await tool.execute({ url: "https://example.com" }, { toolCallId: "test" });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com",
      expect.objectContaining({
        headers: { "User-Agent": "MyBot/2.0" },
      }),
    );
  });

  it("handles HTTP error response", async () => {
    mockFetch.mockResolvedValue(new Response("Not Found", { status: 404 }));

    const tool = createFetchTool(undefined, undefined, mockContext());
    const result = await tool.execute(
      { url: "https://example.com/missing" },
      { toolCallId: "test" },
    );

    expect(textOf(result)).toContain("404");
  });

  it("handles network error", async () => {
    mockFetch.mockRejectedValue(new Error("Connection refused"));

    const tool = createFetchTool(undefined, undefined, mockContext());
    const result = await tool.execute({ url: "https://example.com" }, { toolCallId: "test" });

    expect(textOf(result)).toContain("Connection refused");
  });

  it("handles non-Error thrown objects in catch", async () => {
    mockFetch.mockRejectedValue("raw string error");

    const tool = createFetchTool(undefined, undefined, mockContext());
    const result = await tool.execute({ url: "https://example.com" }, { toolCallId: "test" });

    expect(textOf(result)).toContain("raw string error");
  });

  it("returns plain text when content-type is missing", async () => {
    mockFetch.mockResolvedValue(
      new Response("plain content", {
        status: 200,
        // No content-type header
      }),
    );

    const tool = createFetchTool(undefined, undefined, mockContext());
    const result = await tool.execute({ url: "https://example.com/file" }, { toolCallId: "test" });

    expect(textOf(result)).toBe("plain content");
  });
});
