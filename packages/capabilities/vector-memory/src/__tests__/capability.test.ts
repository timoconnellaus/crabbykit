import type { CapabilityHookContext } from "@claw-for-cloudflare/agent-runtime";
import { createNoopStorage } from "@claw-for-cloudflare/agent-runtime";
import { createMockStorage } from "@claw-for-cloudflare/agent-runtime/test-utils";
import { describe, expect, it, vi } from "vitest";
import { vectorMemory } from "../capability.js";
import { createMockR2Bucket } from "./mock-r2.js";
import { createMockVectorize } from "./mock-vectorize.js";

function mockAi(): Ai {
  return {
    run: async () => ({ data: [[0.1, 0.2, 0.3]] }),
  } as unknown as Ai;
}

function mockBucket(): R2Bucket {
  return {} as R2Bucket;
}

function mockStorage(bucket?: R2Bucket) {
  return {
    bucket: () => bucket ?? mockBucket(),
    namespace: () => "agent-1",
  };
}

function mockHookCtx(storage = createMockStorage()): CapabilityHookContext {
  return {
    agentId: "test-agent",
    sessionId: "s1",
    storage,
  } as unknown as CapabilityHookContext;
}

describe("vectorMemory", () => {
  it("returns correct capability structure", () => {
    const cap = vectorMemory({
      storage: mockStorage(),
      vectorizeIndex: createMockVectorize(),
      ai: mockAi(),
    });

    expect(cap.id).toBe("vector-memory");
    expect(cap.name).toBe("Vector Memory");
    expect(cap.description).toBeDefined();
  });

  it("provides memory_search and memory_get tools", () => {
    const cap = vectorMemory({
      storage: mockStorage(),
      vectorizeIndex: createMockVectorize(),
      ai: mockAi(),
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
      rateLimit: { consume: async () => ({ allowed: true }) },
      notifyBundlePointerChanged: async () => {},
    };

    const tools = cap.tools!(context);
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toEqual(["memory_search", "memory_get"]);
  });

  it("provides prompt sections", () => {
    const cap = vectorMemory({
      storage: mockStorage(),
      vectorizeIndex: createMockVectorize(),
      ai: mockAi(),
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
      rateLimit: { consume: async () => ({ allowed: true }) },
      notifyBundlePointerChanged: async () => {},
    };

    const sections = cap.promptSections!(context);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toContain("memory_search");
    expect(sections[0]).toContain("MEMORY.md");
  });

  it("has afterToolExecution hook", () => {
    const cap = vectorMemory({
      storage: mockStorage(),
      vectorizeIndex: createMockVectorize(),
      ai: mockAi(),
    });

    expect(cap.hooks?.afterToolExecution).toBeDefined();
  });

  it("throws if neither embed nor ai is provided", () => {
    expect(() =>
      vectorMemory({
        storage: mockStorage(),
        vectorizeIndex: createMockVectorize(),
      }),
    ).toThrow("vectorMemory: provide either 'embed' or 'ai' option");
  });

  it("accepts custom embed function", () => {
    const customEmbed = async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]);

    const cap = vectorMemory({
      storage: mockStorage(),
      vectorizeIndex: createMockVectorize(),
      embed: customEmbed,
    });

    // Should not throw
    expect(cap.id).toBe("vector-memory");
  });

  it("accepts getter function for vectorize index", () => {
    const cap = vectorMemory({
      storage: mockStorage(),
      vectorizeIndex: () => createMockVectorize(),
      ai: () => mockAi(),
    });

    expect(cap.id).toBe("vector-memory");
  });
});

describe("afterToolExecution hook", () => {
  function createCapWithHook(bucket: R2Bucket) {
    const vectorize = createMockVectorize();
    const storage = mockStorage(bucket);
    const embed = async (texts: string[]) =>
      texts.map((_, i) => {
        const vec = new Array(3).fill(0);
        vec[i % 3] = 1;
        return vec;
      });

    const cap = vectorMemory({
      storage,
      vectorizeIndex: vectorize,
      embed,
    });

    return { cap, vectorize };
  }

  it("indexes on file_write for memory paths", async () => {
    const bucket = createMockR2Bucket();
    const { cap } = createCapWithHook(bucket);
    const hook = cap.hooks!.afterToolExecution!;
    const ctx = mockHookCtx();

    await hook(
      {
        toolName: "file_write",
        args: {
          path: "MEMORY.md",
          content: "New memory content with enough text to produce a chunk",
        },
        isError: false,
      },
      ctx,
    );

    // Verify hashes were stored (indexDocument ran)
    const hashes = await ctx.storage.get("hashes:MEMORY.md");
    expect(hashes).toBeDefined();

    // Verify vectors were stored (embedding happened)
    const vectors = await ctx.storage.get("vectors:MEMORY.md");
    expect(vectors).toBeDefined();
  });

  it("skips non-memory paths", async () => {
    const bucket = createMockR2Bucket();
    const { cap } = createCapWithHook(bucket);
    const hook = cap.hooks!.afterToolExecution!;
    const ctx = mockHookCtx();

    await hook(
      {
        toolName: "file_write",
        args: { path: "README.md", content: "Not a memory file" },
        isError: false,
      },
      ctx,
    );

    const hashes = await ctx.storage.get("hashes:README.md");
    expect(hashes).toBeUndefined();
  });

  it("skips when isError is true", async () => {
    const bucket = createMockR2Bucket();
    const { cap } = createCapWithHook(bucket);
    const hook = cap.hooks!.afterToolExecution!;
    const ctx = mockHookCtx();

    await hook(
      {
        toolName: "file_write",
        args: { path: "MEMORY.md", content: "Content" },
        isError: true,
      },
      ctx,
    );

    const hashes = await ctx.storage.get("hashes:MEMORY.md");
    expect(hashes).toBeUndefined();
  });

  it("skips file_write when content is missing", async () => {
    const bucket = createMockR2Bucket();
    const { cap } = createCapWithHook(bucket);
    const hook = cap.hooks!.afterToolExecution!;
    const ctx = mockHookCtx();

    await hook(
      {
        toolName: "file_write",
        args: { path: "MEMORY.md" },
        isError: false,
      },
      ctx,
    );

    const hashes = await ctx.storage.get("hashes:MEMORY.md");
    expect(hashes).toBeUndefined();
  });

  it("re-indexes on file_edit by fetching from R2", async () => {
    const bucket = createMockR2Bucket({
      "agent-1/memory/notes.md": "Updated content after edit",
    });
    const { cap } = createCapWithHook(bucket);
    const hook = cap.hooks!.afterToolExecution!;
    const ctx = mockHookCtx();

    await hook(
      {
        toolName: "file_edit",
        args: { path: "memory/notes.md" },
        isError: false,
      },
      ctx,
    );

    const hashes = await ctx.storage.get("hashes:memory/notes.md");
    expect(hashes).toBeDefined();
  });

  it("handles file_edit when R2 object is null", async () => {
    const bucket = createMockR2Bucket(); // empty
    const { cap } = createCapWithHook(bucket);
    const hook = cap.hooks!.afterToolExecution!;
    const ctx = mockHookCtx();

    // Should not throw
    await hook(
      {
        toolName: "file_edit",
        args: { path: "memory/gone.md" },
        isError: false,
      },
      ctx,
    );

    const hashes = await ctx.storage.get("hashes:memory/gone.md");
    expect(hashes).toBeUndefined();
  });

  it("handles file_edit R2 error gracefully", async () => {
    const failBucket = {
      get: async () => {
        throw new Error("R2 down");
      },
    } as unknown as R2Bucket;
    const { cap } = createCapWithHook(failBucket);
    const hook = cap.hooks!.afterToolExecution!;
    const ctx = mockHookCtx();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Should not throw
    await hook(
      {
        toolName: "file_edit",
        args: { path: "MEMORY.md" },
        isError: false,
      },
      ctx,
    );

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("removes vectors on file_delete", async () => {
    const bucket = createMockR2Bucket();
    const { cap, vectorize } = createCapWithHook(bucket);
    const hook = cap.hooks!.afterToolExecution!;
    const ctx = mockHookCtx();

    // First index a document
    await hook(
      {
        toolName: "file_write",
        args: { path: "MEMORY.md", content: "Content to delete" },
        isError: false,
      },
      ctx,
    );

    // Verify it was indexed
    const vectors = await ctx.storage.get("vectors:MEMORY.md");
    expect(vectors).toBeDefined();

    // Now delete
    await hook(
      {
        toolName: "file_delete",
        args: { path: "MEMORY.md" },
        isError: false,
      },
      ctx,
    );

    // Should be cleaned up
    const afterDelete = await ctx.storage.get("vectors:MEMORY.md");
    expect(afterDelete).toBeUndefined();
  });

  it("skips when args have no path", async () => {
    const bucket = createMockR2Bucket();
    const { cap } = createCapWithHook(bucket);
    const hook = cap.hooks!.afterToolExecution!;
    const ctx = mockHookCtx();

    // Should not throw
    await hook(
      {
        toolName: "file_write",
        args: { content: "no path" },
        isError: false,
      },
      ctx,
    );
  });

  it("skips when args is undefined", async () => {
    const bucket = createMockR2Bucket();
    const { cap } = createCapWithHook(bucket);
    const hook = cap.hooks!.afterToolExecution!;
    const ctx = mockHookCtx();

    // Should not throw
    await hook(
      {
        toolName: "file_write",
        args: undefined,
        isError: false,
      },
      ctx,
    );
  });

  it("indexes via ai-backed embedder on file_write", async () => {
    const bucket = createMockR2Bucket();
    const vectorize = createMockVectorize();
    const ai = {
      run: async () => ({ data: [[0.1, 0.2, 0.3]] }),
    } as unknown as Ai;

    const cap = vectorMemory({
      storage: mockStorage(bucket),
      vectorizeIndex: vectorize,
      ai, // use ai option (not embed) to exercise the getAi arrow
    });

    const hook = cap.hooks!.afterToolExecution!;
    const ctx = mockHookCtx();

    await hook(
      {
        toolName: "file_write",
        args: { path: "MEMORY.md", content: "Content to index via AI embedder" },
        isError: false,
      },
      ctx,
    );

    const vectors = await ctx.storage.get("vectors:MEMORY.md");
    expect(vectors).toBeDefined();
  });

  it("uses custom isMemoryPath when provided", async () => {
    const bucket = createMockR2Bucket();
    const vectorize = createMockVectorize();
    const embed = async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]);

    const cap = vectorMemory({
      storage: mockStorage(bucket),
      vectorizeIndex: vectorize,
      embed,
      isMemoryPath: (p) => p.endsWith(".notes"),
    });

    const hook = cap.hooks!.afterToolExecution!;
    const ctx = mockHookCtx();

    // Standard memory path should be skipped
    await hook(
      {
        toolName: "file_write",
        args: { path: "MEMORY.md", content: "Content" },
        isError: false,
      },
      ctx,
    );
    expect(await ctx.storage.get("hashes:MEMORY.md")).toBeUndefined();

    // Custom path should be indexed
    await hook(
      {
        toolName: "file_write",
        args: { path: "project.notes", content: "Custom content" },
        isError: false,
      },
      ctx,
    );
    expect(await ctx.storage.get("hashes:project.notes")).toBeDefined();
  });
});
