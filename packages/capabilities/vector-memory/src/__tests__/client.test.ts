/**
 * vectorMemoryClient unit tests (task 3.11).
 *
 * Verifies:
 *  - capability id matches the scope string "vector-memory"
 *  - bundle-side promptSections is content-only (no `excluded` entries)
 *  - missing __BUNDLE_TOKEN throws on both tools
 *  - capability has NO `hooks` — bundle client must NOT register a
 *    duplicate indexing hook (Phase 0 bridge fires the static cap's hook)
 *  - tools forward `(token, args, SCHEMA_CONTENT_HASH)` to the mock service
 */

import type { AgentTool } from "@claw-for-cloudflare/agent-core";
import type { AgentContext } from "@claw-for-cloudflare/agent-runtime";
import { createNoopStorage } from "@claw-for-cloudflare/agent-runtime";
import { textOf } from "@claw-for-cloudflare/agent-runtime/test-utils";
import { describe, expect, it, vi } from "vitest";
import { vectorMemoryClient } from "../client.js";
import { MEMORY_GET_TOOL_NAME, MEMORY_SEARCH_TOOL_NAME, SCHEMA_CONTENT_HASH } from "../schemas.js";
import type { VectorMemoryService } from "../service.js";

function makeMockService() {
  return {
    search: vi.fn(),
    get: vi.fn(),
  } as unknown as Service<VectorMemoryService> & {
    search: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
  };
}

function makeContext(token?: string): AgentContext & {
  env: { __BUNDLE_TOKEN?: string };
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
    env: { __BUNDLE_TOKEN: token },
  } as unknown as AgentContext & { env: { __BUNDLE_TOKEN?: string } };
}

// biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance is irrelevant in tests
function toolByName(tools: AgentTool<any>[], name: string): AgentTool<any> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

describe("vectorMemoryClient capability shape", () => {
  it("has id 'vector-memory' matching the catalog scope string", () => {
    const cap = vectorMemoryClient({ service: makeMockService() });
    expect(cap.id).toBe("vector-memory");
  });

  it("registers NO lifecycle hooks (Phase 0 bridge fires static cap's hook)", () => {
    const cap = vectorMemoryClient({ service: makeMockService() });
    expect(cap.hooks).toBeUndefined();
  });

  it("registers no httpHandlers", () => {
    const cap = vectorMemoryClient({ service: makeMockService() });
    expect(cap.httpHandlers).toBeUndefined();
  });

  it("registers no configNamespaces", () => {
    const cap = vectorMemoryClient({ service: makeMockService() });
    expect(cap.configNamespaces).toBeUndefined();
  });

  it("registers no onAction handler", () => {
    const cap = vectorMemoryClient({ service: makeMockService() });
    expect(cap.onAction).toBeUndefined();
  });

  it("exposes a content-only promptSections (no excluded entries)", () => {
    const cap = vectorMemoryClient({ service: makeMockService() });
    const ctx = makeContext("tok");
    const sections = cap.promptSections!(ctx);

    expect(Array.isArray(sections)).toBe(true);
    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections) {
      // A bare string is an included-content section per the SDK contract.
      if (typeof section === "string") continue;
      // Inspect the inspection-panel-visible descriptor — must NOT be
      // excluded. The bundle client's prompt is always included.
      expect((section as { kind?: string }).kind).not.toBe("excluded");
    }
  });

  it("produces exactly two tools: memory_search and memory_get", () => {
    const cap = vectorMemoryClient({ service: makeMockService() });
    const ctx = makeContext("tok");
    // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance is irrelevant in tests
    const tools = cap.tools!(ctx) as unknown as AgentTool<any>[];
    expect(tools).toHaveLength(2);
    const names = tools.map((t) => t.name);
    expect(names).toContain(MEMORY_SEARCH_TOOL_NAME);
    expect(names).toContain(MEMORY_GET_TOOL_NAME);
  });
});

describe("memory_search tool", () => {
  it("forwards __BUNDLE_TOKEN + args + SCHEMA_CONTENT_HASH to service.search", async () => {
    const service = makeMockService();
    service.search.mockResolvedValue({
      results: [{ path: "MEMORY.md", score: 0.9, snippet: "some snippet" }],
    });

    const cap = vectorMemoryClient({ service });
    const ctx = makeContext("tok-abc");
    // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance is irrelevant in tests
    const tools = cap.tools!(ctx) as unknown as AgentTool<any>[];
    const search = toolByName(tools, MEMORY_SEARCH_TOOL_NAME);

    const result = await search.execute!({ query: "find it", maxResults: 3 }, ctx as never);

    expect(service.search).toHaveBeenCalledOnce();
    const [token, passedArgs, hash] = service.search.mock.calls[0];
    expect(token).toBe("tok-abc");
    expect(passedArgs).toEqual({ query: "find it", maxResults: 3 });
    expect(hash).toBe(SCHEMA_CONTENT_HASH);
    expect(textOf(result)).toContain("MEMORY.md");
    expect(textOf(result)).toContain("some snippet");
  });

  it("renders empty results with a sentinel text line", async () => {
    const service = makeMockService();
    service.search.mockResolvedValue({ results: [] });

    const cap = vectorMemoryClient({ service });
    const ctx = makeContext("tok");
    // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance is irrelevant in tests
    const tools = cap.tools!(ctx) as unknown as AgentTool<any>[];
    const search = toolByName(tools, MEMORY_SEARCH_TOOL_NAME);

    const result = await search.execute!({ query: "nothing" }, ctx as never);
    expect(textOf(result)).toContain("No memory content found");
  });

  it("throws when __BUNDLE_TOKEN is absent from env", async () => {
    const service = makeMockService();
    const cap = vectorMemoryClient({ service });
    const ctx = makeContext(undefined);
    // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance is irrelevant in tests
    const tools = cap.tools!(ctx) as unknown as AgentTool<any>[];
    const search = toolByName(tools, MEMORY_SEARCH_TOOL_NAME);

    await expect(search.execute!({ query: "x" }, ctx as never)).rejects.toThrow(
      "Missing __BUNDLE_TOKEN",
    );
    expect(service.search).not.toHaveBeenCalled();
  });
});

describe("memory_get tool", () => {
  it("forwards __BUNDLE_TOKEN + args + SCHEMA_CONTENT_HASH to service.get", async () => {
    const service = makeMockService();
    service.get.mockResolvedValue({ content: "# Memory\n\nNotes." });

    const cap = vectorMemoryClient({ service });
    const ctx = makeContext("tok-abc");
    // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance is irrelevant in tests
    const tools = cap.tools!(ctx) as unknown as AgentTool<any>[];
    const get = toolByName(tools, MEMORY_GET_TOOL_NAME);

    const result = await get.execute!({ path: "MEMORY.md" }, ctx as never);

    expect(service.get).toHaveBeenCalledOnce();
    const [token, passedArgs, hash] = service.get.mock.calls[0];
    expect(token).toBe("tok-abc");
    expect(passedArgs).toEqual({ path: "MEMORY.md" });
    expect(hash).toBe(SCHEMA_CONTENT_HASH);
    expect(textOf(result)).toBe("# Memory\n\nNotes.");
  });

  it("renders empty content with a sentinel fallback text", async () => {
    const service = makeMockService();
    service.get.mockResolvedValue({ content: "" });

    const cap = vectorMemoryClient({ service });
    const ctx = makeContext("tok");
    // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance is irrelevant in tests
    const tools = cap.tools!(ctx) as unknown as AgentTool<any>[];
    const get = toolByName(tools, MEMORY_GET_TOOL_NAME);

    const result = await get.execute!({ path: "MEMORY.md" }, ctx as never);
    expect(textOf(result)).toBe("No content found.");
  });

  it("throws when __BUNDLE_TOKEN is absent from env", async () => {
    const service = makeMockService();
    const cap = vectorMemoryClient({ service });
    const ctx = makeContext(undefined);
    // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance is irrelevant in tests
    const tools = cap.tools!(ctx) as unknown as AgentTool<any>[];
    const get = toolByName(tools, MEMORY_GET_TOOL_NAME);

    await expect(get.execute!({ path: "x" }, ctx as never)).rejects.toThrow(
      "Missing __BUNDLE_TOKEN",
    );
    expect(service.get).not.toHaveBeenCalled();
  });
});
