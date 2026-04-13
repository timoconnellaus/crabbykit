/**
 * tavilyClient unit tests (task 4.31).
 *
 * Verifies:
 *  - tool calls forward the __SPINE_TOKEN to service.search / service.extract
 *  - the token comes from env only (never from LLM args)
 *  - tools throw when __SPINE_TOKEN is missing (bundle not wired correctly)
 *  - the client never imports TavilyService credentials
 *  - schema hash is passed through for drift detection
 *  - result formatting
 */

import type { AgentContext } from "@claw-for-cloudflare/agent-runtime";
import type { AgentTool } from "@claw-for-cloudflare/agent-core";
import { createNoopStorage } from "@claw-for-cloudflare/agent-runtime";
import { textOf } from "@claw-for-cloudflare/agent-runtime/test-utils";
import { describe, expect, it, vi } from "vitest";
import { tavilyClient } from "../client.js";
import { SCHEMA_CONTENT_HASH } from "../schemas.js";
import type { TavilyService } from "../service.js";

function makeMockService() {
  return {
    search: vi.fn(),
    extract: vi.fn(),
  } as unknown as Service<TavilyService> & {
    search: ReturnType<typeof vi.fn>;
    extract: ReturnType<typeof vi.fn>;
  };
}

function makeContext(token?: string): AgentContext & {
  env: { __SPINE_TOKEN?: string };
} {
  return {
    agentId: "agent",
    sessionId: "session",
    stepNumber: 0,
    emitCost: vi.fn(),
    broadcast: () => {},
    broadcastToAll: () => {},
    broadcastState: () => {},
    requestFromClient: () => Promise.reject(new Error("Not available")),
    storage: createNoopStorage(),
    schedules: {} as never,
    rateLimit: { consume: async () => ({ allowed: true }) },
    env: { __SPINE_TOKEN: token },
  } as unknown as AgentContext & { env: { __SPINE_TOKEN?: string } };
}

// biome-ignore lint/suspicious/noExplicitAny: test helper
function toolByName(tools: AgentTool<any>[], name: string): AgentTool<any> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

describe("tavilyClient capability shape", () => {
  it("has expected id and name", () => {
    const cap = tavilyClient({ service: makeMockService() });
    expect(cap.id).toBe("tavily-web-search");
    expect(cap.name).toContain("Tavily");
  });

  it("produces web_search and web_fetch tools", () => {
    const cap = tavilyClient({ service: makeMockService() });
    const ctx = makeContext("tok");
    const tools = cap.tools!(ctx) as unknown as AgentTool<any>[];
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["web_fetch", "web_search"]);
  });
});

describe("web_search tool", () => {
  it("forwards __SPINE_TOKEN and args to service.search with schema hash", async () => {
    const service = makeMockService();
    service.search.mockResolvedValue({
      results: [
        {
          title: "First",
          url: "https://one.example",
          content: "snippet-one",
        },
      ],
    });

    const cap = tavilyClient({ service });
    const ctx = makeContext("tok-abc");
    const tools = cap.tools!(ctx) as unknown as AgentTool<any>[];
    const search = toolByName(tools, "web_search");

    const result = await search.execute!(
      { query: "lambda calculus", maxResults: 3 },
      ctx as never,
    );

    expect(service.search).toHaveBeenCalledOnce();
    const [token, passedArgs, hash] = service.search.mock.calls[0];
    expect(token).toBe("tok-abc");
    expect(passedArgs).toEqual({ query: "lambda calculus", maxResults: 3 });
    expect(hash).toBe(SCHEMA_CONTENT_HASH);
    expect(textOf(result)).toContain("First");
  });

  it("reads token from env only — LLM args containing a token are ignored", async () => {
    const service = makeMockService();
    service.search.mockResolvedValue({ results: [] });
    const cap = tavilyClient({ service });
    const ctx = makeContext("real-env-token");
    const tools = cap.tools!(ctx) as unknown as AgentTool<any>[];
    const search = toolByName(tools, "web_search");

    await search.execute!(
      {
        query: "q",
        // Exercising the trust boundary: LLM-supplied tokens should be ignored
        __SPINE_TOKEN: "llm-forged-token",
      },
      ctx as never,
    );

    expect(service.search.mock.calls[0][0]).toBe("real-env-token");
  });

  it("throws when __SPINE_TOKEN is absent from env", async () => {
    const service = makeMockService();
    const cap = tavilyClient({ service });
    const ctx = makeContext(undefined);
    const tools = cap.tools!(ctx) as unknown as AgentTool<any>[];
    const search = toolByName(tools, "web_search");

    await expect(
      search.execute!({ query: "q" }, ctx as never),
    ).rejects.toThrow("Missing __SPINE_TOKEN");
    expect(service.search).not.toHaveBeenCalled();
  });

  it("returns 'No results found.' when service yields empty results", async () => {
    const service = makeMockService();
    service.search.mockResolvedValue({ results: [] });
    const cap = tavilyClient({ service });
    const ctx = makeContext("tok");
    const tools = cap.tools!(ctx) as unknown as AgentTool<any>[];
    const search = toolByName(tools, "web_search");

    const result = await search.execute!({ query: "q" }, ctx as never);
    expect(textOf(result)).toBe("No results found.");
  });
});

describe("web_fetch tool", () => {
  it("forwards __SPINE_TOKEN, url, and schema hash to service.extract", async () => {
    const service = makeMockService();
    service.extract.mockResolvedValue({ content: "page text" });
    const cap = tavilyClient({ service });
    const ctx = makeContext("tok-x");
    const tools = cap.tools!(ctx) as unknown as AgentTool<any>[];
    const fetch = toolByName(tools, "web_fetch");

    const result = await fetch.execute!(
      { url: "https://a.example" },
      ctx as never,
    );

    expect(service.extract).toHaveBeenCalledOnce();
    const [token, passedArgs, hash] = service.extract.mock.calls[0];
    expect(token).toBe("tok-x");
    expect(passedArgs).toEqual({ url: "https://a.example" });
    expect(hash).toBe(SCHEMA_CONTENT_HASH);
    expect(textOf(result)).toBe("page text");
  });

  it("throws when __SPINE_TOKEN is absent", async () => {
    const service = makeMockService();
    const cap = tavilyClient({ service });
    const ctx = makeContext(undefined);
    const tools = cap.tools!(ctx) as unknown as AgentTool<any>[];
    const fetch = toolByName(tools, "web_fetch");

    await expect(
      fetch.execute!({ url: "https://a" }, ctx as never),
    ).rejects.toThrow("Missing __SPINE_TOKEN");
    expect(service.extract).not.toHaveBeenCalled();
  });

  it("returns 'No content extracted.' on empty extract response", async () => {
    const service = makeMockService();
    service.extract.mockResolvedValue({ content: "" });
    const cap = tavilyClient({ service });
    const ctx = makeContext("tok");
    const tools = cap.tools!(ctx) as unknown as AgentTool<any>[];
    const fetch = toolByName(tools, "web_fetch");

    const result = await fetch.execute!(
      { url: "https://a" },
      ctx as never,
    );
    expect(textOf(result)).toBe("No content extracted.");
  });
});

describe("tavilyClient credential isolation", () => {
  it("does not read TAVILY_API_KEY from env — only __SPINE_TOKEN", async () => {
    const service = makeMockService();
    service.search.mockResolvedValue({ results: [] });
    const cap = tavilyClient({ service });
    const envWithSecret = {
      __SPINE_TOKEN: "tok",
      TAVILY_API_KEY: "sk-leaked-123",
    };
    const ctx = {
      ...makeContext("tok"),
      env: envWithSecret,
    } as unknown as AgentContext;
    const tools = cap.tools!(ctx) as unknown as AgentTool<any>[];
    const search = toolByName(tools, "web_search");
    await search.execute!({ query: "q" }, ctx as never);

    // service.search gets the token string only — never the API key
    const [token, args] = service.search.mock.calls[0];
    expect(token).toBe("tok");
    expect(token).not.toContain("sk-leaked");
    expect(JSON.stringify(args)).not.toContain("sk-leaked");
  });
});
