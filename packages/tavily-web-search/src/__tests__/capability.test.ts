import { describe, expect, it } from "vitest";
import { tavilyWebSearch } from "../capability.js";

describe("tavilyWebSearch", () => {
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
      sessionId: "s1",
      stepNumber: 0,
      emitCost: () => {},
      broadcast: () => {},
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
      sessionId: "s1",
      stepNumber: 0,
      emitCost: () => {},
      broadcast: () => {},
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
      sessionId: "s1",
      stepNumber: 0,
      emitCost: () => {},
      broadcast: () => {},
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
      sessionId: "s1",
      stepNumber: 0,
      emitCost: () => {},
      broadcast: () => {},
      schedules: {} as any,
    });
    expect(tools).toHaveLength(2);
  });

  it("has no lifecycle hooks", () => {
    const cap = tavilyWebSearch({ tavilyApiKey: "key" });
    expect(cap.hooks).toBeUndefined();
  });
});
