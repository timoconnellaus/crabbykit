import { describe, expect, it, vi } from "vitest";
import type { AgentContext } from "@claw-for-cloudflare/agent-runtime";
import type { EmbedFn } from "../embeddings.js";
import { createMemorySearchTool } from "../memory-search.js";
import { createMockR2Bucket } from "./mock-r2.js";
import { createMockVectorize } from "./mock-vectorize.js";

function mockEmbed(): EmbedFn {
  return async (texts: string[]) =>
    texts.map((_, i) => {
      const vec = new Array(3).fill(0);
      vec[i % 3] = 1;
      return vec;
    });
}

function mockContext(): AgentContext {
  return {
    agentId: "test-agent",
    sessionId: "s1",
    stepNumber: 0,
    emitCost: vi.fn(),
    broadcast: () => {},
    broadcastToAll: () => {},
    requestFromClient: () => Promise.reject(new Error("Not available")),
    schedules: {} as AgentContext["schedules"],
  };
}

const TOOL_CTX = { toolCallId: "test" };

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return (result.content[0] as { text: string }).text;
}

describe("memory_search tool", () => {
  it("returns vector search results and emits cost", async () => {
    const vectorize = createMockVectorize();
    const embed = mockEmbed();
    const prefix = "agent-1";
    const ctx = mockContext();

    // Seed vectorize with data
    await vectorize.upsert([
      {
        id: "MEMORY.md:1",
        values: [1, 0, 0],
        namespace: prefix,
        metadata: { path: "MEMORY.md", startLine: 1, endLine: 3 },
      },
    ]);

    const bucket = createMockR2Bucket({
      "agent-1/MEMORY.md": "Important memory content\nLine 2\nLine 3",
    });

    const tool = createMemorySearchTool(
      () => bucket,
      () => vectorize,
      () => prefix,
      embed,
      5,
      ctx,
    );

    const result = await tool.execute({ query: "memory" }, TOOL_CTX);
    const text = textOf(result);
    expect(text).toContain("MEMORY.md");
    expect(result.details).toHaveProperty("resultCount");

    // Should have emitted a cost
    expect(ctx.emitCost).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityId: "vector-memory",
        toolName: "memory_search",
        currency: "USD",
      }),
    );
  });

  it("falls back to keyword search when vector search returns null", async () => {
    // Embed that returns empty to trigger null from vectorSearch
    const failEmbed: EmbedFn = async () => [];
    const prefix = "agent-1";
    const ctx = mockContext();

    const bucket = createMockR2Bucket({
      "agent-1/MEMORY.md": "Content with searchable keyword",
    });

    const tool = createMemorySearchTool(
      () => bucket,
      () => createMockVectorize(),
      () => prefix,
      failEmbed,
      5,
      ctx,
    );

    const result = await tool.execute({ query: "keyword" }, TOOL_CTX);
    const text = textOf(result);

    expect(text).toContain("keyword search");
    expect(text).toContain("keyword");
    // Should NOT emit cost for keyword fallback
    expect(ctx.emitCost).not.toHaveBeenCalled();
  });

  it("uses custom max_results from args", async () => {
    const vectorize = createMockVectorize();
    const embed = mockEmbed();
    const prefix = "agent-1";
    const ctx = mockContext();

    // Seed multiple files
    for (let i = 0; i < 5; i++) {
      await vectorize.upsert([
        {
          id: `file${i}.md:1`,
          values: [1, 0, 0],
          namespace: prefix,
          metadata: { path: `file${i}.md`, startLine: 1, endLine: 2 },
        },
      ]);
    }

    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) {
      files[`agent-1/file${i}.md`] = `Content of file ${i}`;
    }
    const bucket = createMockR2Bucket(files);

    const tool = createMemorySearchTool(
      () => bucket,
      () => vectorize,
      () => prefix,
      embed,
      10,
      ctx,
    );

    const result = await tool.execute({ query: "test", max_results: 2 }, TOOL_CTX);
    expect(result.details.resultCount).toBeLessThanOrEqual(2);
  });

  it("returns no-match message when no results found", async () => {
    const vectorize = createMockVectorize();
    const embed = mockEmbed();
    const ctx = mockContext();

    const tool = createMemorySearchTool(
      () => createMockR2Bucket(),
      () => vectorize,
      () => "agent-1",
      embed,
      5,
      ctx,
    );

    const result = await tool.execute({ query: "nonexistent" }, TOOL_CTX);
    expect(textOf(result)).toContain("No memory content found");
  });
});
