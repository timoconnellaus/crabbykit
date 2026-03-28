import { describe, expect, it, vi } from "vitest";
import type { EmbedFn } from "../embeddings.js";
import { indexDocument, removeDocument } from "../indexer.js";
import { createMockStorage } from "./mock-storage.js";
import { createMockVectorize } from "./mock-vectorize.js";

/** Simple mock embedder that returns unit vectors */
function mockEmbed(): EmbedFn {
  return async (texts: string[]) =>
    texts.map((_, i) => {
      const vec = new Array(3).fill(0);
      vec[i % 3] = 1;
      return vec;
    });
}

describe("indexDocument", () => {
  it("indexes a new document with chunks", async () => {
    const storage = createMockStorage();
    const vectorize = createMockVectorize();
    const embed = mockEmbed();

    const result = await indexDocument(
      "MEMORY.md",
      "Hello world\n\nThis is a test document.",
      "agent-1",
      embed,
      vectorize,
      storage,
    );

    expect(result.chunksTotal).toBeGreaterThanOrEqual(1);
    expect(result.chunksEmbedded).toBe(result.chunksTotal);
    expect(result.vectorsDeleted).toBe(0);

    // Verify hashes and vectors were stored
    const hashes = await storage.get<Record<string, string>>("hashes:MEMORY.md");
    expect(hashes).toBeDefined();

    const vectors = await storage.get<string[]>("vectors:MEMORY.md");
    expect(vectors).toBeDefined();
    expect(vectors!.length).toBe(result.chunksTotal);
  });

  it("skips re-embedding unchanged content", async () => {
    const storage = createMockStorage();
    const vectorize = createMockVectorize();
    const embed = vi.fn(mockEmbed());
    const content = "Hello world\n\nThis is a test.";

    // First index
    await indexDocument("MEMORY.md", content, "agent-1", embed, vectorize, storage);
    const firstCallCount = embed.mock.calls.length;

    // Re-index same content
    const result = await indexDocument("MEMORY.md", content, "agent-1", embed, vectorize, storage);

    expect(result.chunksEmbedded).toBe(0);
    // embed should not have been called again
    expect(embed.mock.calls.length).toBe(firstCallCount);
  });

  it("re-embeds changed chunks", async () => {
    const storage = createMockStorage();
    const vectorize = createMockVectorize();
    const embed = vi.fn(mockEmbed());

    await indexDocument("MEMORY.md", "Original content.", "agent-1", embed, vectorize, storage);

    const result = await indexDocument(
      "MEMORY.md",
      "Updated content.",
      "agent-1",
      embed,
      vectorize,
      storage,
    );

    expect(result.chunksEmbedded).toBeGreaterThanOrEqual(1);
  });

  it("deletes stale vectors when chunks are removed", async () => {
    const storage = createMockStorage();
    const vectorize = createMockVectorize();
    const embed = mockEmbed();

    // Create content with multiple paragraphs that produce multiple chunks
    const paragraphs = [];
    for (let i = 0; i < 20; i++) {
      paragraphs.push(`Paragraph ${i}: ${"x".repeat(150)}`);
    }

    await indexDocument("MEMORY.md", paragraphs.join("\n\n"), "agent-1", embed, vectorize, storage);

    const firstVectors = await storage.get<string[]>("vectors:MEMORY.md");
    expect(firstVectors!.length).toBeGreaterThan(1);

    // Reduce to just one paragraph
    const result = await indexDocument(
      "MEMORY.md",
      "Short content now.",
      "agent-1",
      embed,
      vectorize,
      storage,
    );

    expect(result.vectorsDeleted).toBeGreaterThan(0);
  });

  it("handles embed errors gracefully", async () => {
    const storage = createMockStorage();
    const vectorize = createMockVectorize();
    const failingEmbed: EmbedFn = async () => {
      throw new Error("AI service unavailable");
    };

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await indexDocument(
      "MEMORY.md",
      "Some content.",
      "agent-1",
      failingEmbed,
      vectorize,
      storage,
    );

    // Should return zero counts, not throw
    expect(result.chunksTotal).toBe(0);
    expect(result.chunksEmbedded).toBe(0);

    consoleSpy.mockRestore();
  });
});

describe("removeDocument", () => {
  it("removes vectors and cleans up storage", async () => {
    const storage = createMockStorage();
    const vectorize = createMockVectorize();
    const embed = mockEmbed();

    await indexDocument("MEMORY.md", "Content to remove.", "agent-1", embed, vectorize, storage);

    const removed = await removeDocument("MEMORY.md", "agent-1", vectorize, storage);
    expect(removed).toBeGreaterThanOrEqual(1);

    // Storage should be cleaned up
    expect(await storage.get("hashes:MEMORY.md")).toBeUndefined();
    expect(await storage.get("vectors:MEMORY.md")).toBeUndefined();
  });

  it("handles missing document gracefully", async () => {
    const storage = createMockStorage();
    const vectorize = createMockVectorize();

    const removed = await removeDocument("nonexistent.md", "agent-1", vectorize, storage);
    expect(removed).toBe(0);
  });
});
