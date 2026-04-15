import { describe, expect, it, vi } from "vitest";
import type { EmbedFn } from "../embeddings.js";
import { formatResults, keywordSearch, vectorSearch } from "../searcher.js";
import { createMockR2Bucket } from "./mock-r2.js";
import { createMockVectorize } from "./mock-vectorize.js";

/** Embed that returns a simple unit vector based on index */
function mockEmbed(): EmbedFn {
  return async (texts: string[]) =>
    texts.map((_, i) => {
      const vec = new Array(3).fill(0);
      vec[i % 3] = 1;
      return vec;
    });
}

describe("vectorSearch", () => {
  it("returns results from vectorize with R2 snippets", async () => {
    const vectorize = createMockVectorize();
    const embed = mockEmbed();
    const prefix = "agent-1";

    // Seed vectorize with a vector
    await vectorize.upsert([
      {
        id: "MEMORY.md:1",
        values: [1, 0, 0],
        namespace: prefix,
        metadata: { path: "MEMORY.md", startLine: 1, endLine: 3 },
      },
    ]);

    // Seed R2 with the corresponding file
    const bucket = createMockR2Bucket({
      "agent-1/MEMORY.md": "Line one\nLine two\nLine three\nLine four",
    });

    const results = await vectorSearch("test query", 5, prefix, embed, vectorize, () => bucket);

    expect(results).not.toBeNull();
    expect(results!.length).toBeGreaterThanOrEqual(1);
    expect(results![0].path).toBe("MEMORY.md");
    expect(results![0].snippet).toContain("Line one");
  });

  it("returns null when embed returns empty vectors", async () => {
    const vectorize = createMockVectorize();
    const emptyEmbed: EmbedFn = async () => [];
    const bucket = createMockR2Bucket();

    const results = await vectorSearch("query", 5, "agent-1", emptyEmbed, vectorize, () => bucket);

    expect(results).toBeNull();
  });

  it("returns null when vectorize query throws", async () => {
    const failingVectorize = {
      ...createMockVectorize(),
      query: async () => {
        throw new Error("Vectorize down");
      },
    } as unknown as VectorizeIndex;

    const embed = mockEmbed();
    const bucket = createMockR2Bucket();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const results = await vectorSearch(
      "query",
      5,
      "agent-1",
      embed,
      failingVectorize,
      () => bucket,
    );

    expect(results).toBeNull();
    consoleSpy.mockRestore();
  });

  it("returns empty array when no matches", async () => {
    const vectorize = createMockVectorize();
    const embed = mockEmbed();
    const bucket = createMockR2Bucket();

    const results = await vectorSearch("query", 5, "agent-1", embed, vectorize, () => bucket);

    expect(results).toEqual([]);
  });

  it("deduplicates matches by path keeping highest score", async () => {
    const vectorize = createMockVectorize();
    const embed = mockEmbed();
    const prefix = "agent-1";

    // Two vectors for the same file, different chunks
    await vectorize.upsert([
      {
        id: "MEMORY.md:1",
        values: [1, 0, 0],
        namespace: prefix,
        metadata: { path: "MEMORY.md", startLine: 1, endLine: 2 },
      },
      {
        id: "MEMORY.md:5",
        values: [0.9, 0.1, 0],
        namespace: prefix,
        metadata: { path: "MEMORY.md", startLine: 5, endLine: 8 },
      },
    ]);

    const bucket = createMockR2Bucket({
      "agent-1/MEMORY.md": "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8",
    });

    const results = await vectorSearch("test", 5, prefix, embed, vectorize, () => bucket);

    // Should only have one result per path
    const paths = results!.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("skips matches with no metadata path", async () => {
    const vectorize = createMockVectorize();
    const embed = mockEmbed();
    const prefix = "agent-1";

    await vectorize.upsert([
      {
        id: "no-meta:1",
        values: [1, 0, 0],
        namespace: prefix,
        metadata: {}, // no path
      },
    ]);

    const bucket = createMockR2Bucket();

    const results = await vectorSearch("test", 5, prefix, embed, vectorize, () => bucket);

    expect(results).toEqual([]);
  });

  it("handles R2 get failure gracefully", async () => {
    const vectorize = createMockVectorize();
    const embed = mockEmbed();
    const prefix = "agent-1";

    await vectorize.upsert([
      {
        id: "MEMORY.md:1",
        values: [1, 0, 0],
        namespace: prefix,
        metadata: { path: "MEMORY.md", startLine: 1, endLine: 3 },
      },
    ]);

    // Bucket that throws on get
    const failingBucket = {
      get: async () => {
        throw new Error("R2 error");
      },
    } as unknown as R2Bucket;

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const results = await vectorSearch("test", 5, prefix, embed, vectorize, () => failingBucket);

    // Should still return a result but with empty snippet
    expect(results).not.toBeNull();
    expect(results!.length).toBe(1);
    expect(results![0].snippet).toBe("");

    consoleSpy.mockRestore();
  });

  it("returns empty snippet when R2 object is null", async () => {
    const vectorize = createMockVectorize();
    const embed = mockEmbed();
    const prefix = "agent-1";

    await vectorize.upsert([
      {
        id: "missing.md:1",
        values: [1, 0, 0],
        namespace: prefix,
        metadata: { path: "missing.md", startLine: 1, endLine: 3 },
      },
    ]);

    const bucket = createMockR2Bucket(); // empty — file not found

    const results = await vectorSearch("test", 5, prefix, embed, vectorize, () => bucket);

    expect(results!.length).toBe(1);
    expect(results![0].snippet).toBe("");
  });

  it("truncates long snippets", async () => {
    const vectorize = createMockVectorize();
    const embed = mockEmbed();
    const prefix = "agent-1";

    await vectorize.upsert([
      {
        id: "big.md:1",
        values: [1, 0, 0],
        namespace: prefix,
        metadata: { path: "big.md", startLine: 1, endLine: 100 },
      },
    ]);

    // Create content larger than SNIPPET_MAX_CHARS (700)
    const longContent = Array.from({ length: 100 }, (_, i) => `Line ${i}: ${"x".repeat(20)}`).join(
      "\n",
    );
    const bucket = createMockR2Bucket({ "agent-1/big.md": longContent });

    const results = await vectorSearch("test", 5, prefix, embed, vectorize, () => bucket);

    expect(results![0].snippet.length).toBeLessThanOrEqual(701); // 700 + ellipsis char
  });
});

describe("keywordSearch", () => {
  it("finds matching lines with context window", async () => {
    const prefix = "agent-1";
    const content = [
      "# Notes",
      "",
      "Some context before",
      "The important keyword here",
      "Some context after",
      "",
      "Unrelated stuff",
    ].join("\n");

    const bucket = createMockR2Bucket({
      "agent-1/MEMORY.md": content,
    });

    const results = await keywordSearch("keyword", 5, prefix, () => bucket);

    expect(results.length).toBe(1);
    expect(results[0].snippet).toContain("keyword");
    expect(results[0].path).toBe("MEMORY.md");
  });

  it("returns empty when no matches", async () => {
    const bucket = createMockR2Bucket({
      "agent-1/MEMORY.md": "Nothing relevant here",
    });

    const results = await keywordSearch("nonexistent", 5, "agent-1", () => bucket);
    expect(results).toEqual([]);
  });

  it("respects maxResults limit", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `target word on line ${i}`).join("\n");
    const bucket = createMockR2Bucket({
      "agent-1/MEMORY.md": lines,
    });

    const results = await keywordSearch("target", 2, "agent-1", () => bucket);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("avoids overlapping results from same file", async () => {
    // Two "target" lines close together should merge into one result
    const lines = ["target line 1", "target line 2", "filler", "filler", "filler"].join("\n");

    const bucket = createMockR2Bucket({
      "agent-1/MEMORY.md": lines,
    });

    const results = await keywordSearch("target", 10, "agent-1", () => bucket);
    // With KEYWORD_CONTEXT_LINES=5, these are overlapping
    expect(results.length).toBe(1);
  });

  it("searches memory/ directory files", async () => {
    const bucket = createMockR2Bucket({
      "agent-1/memory/notes.md": "Some searchable content with keyword",
    });

    const results = await keywordSearch("keyword", 5, "agent-1", () => bucket);
    expect(results.length).toBe(1);
    expect(results[0].path).toBe("memory/notes.md");
  });

  it("handles R2 get failure gracefully", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Bucket where head works but get throws
    const bucket = {
      head: async () => ({ key: "agent-1/MEMORY.md" }),
      list: async () => ({ objects: [] }),
      get: async () => {
        throw new Error("R2 read error");
      },
    } as unknown as R2Bucket;

    const results = await keywordSearch("test", 5, "agent-1", () => bucket);
    expect(results).toEqual([]);

    consoleSpy.mockRestore();
  });

  it("handles list failure gracefully", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const bucket = {
      head: async () => null,
      list: async () => {
        throw new Error("list error");
      },
    } as unknown as R2Bucket;

    const results = await keywordSearch("test", 5, "agent-1", () => bucket);
    expect(results).toEqual([]);

    consoleSpy.mockRestore();
  });

  it("is case-insensitive", async () => {
    const bucket = createMockR2Bucket({
      "agent-1/MEMORY.md": "This has a KEYWORD in uppercase",
    });

    const results = await keywordSearch("keyword", 5, "agent-1", () => bucket);
    expect(results.length).toBe(1);
  });
});

describe("formatResults", () => {
  it("formats results with location and score", () => {
    const output = formatResults([
      { path: "MEMORY.md", startLine: 1, endLine: 5, score: 0.9123, snippet: "Some content" },
    ]);

    expect(output).toContain("[1] MEMORY.md:1-5");
    expect(output).toContain("(score: 0.912)");
    expect(output).toContain("Some content");
  });

  it("formats results without score", () => {
    const output = formatResults([
      { path: "notes.md", startLine: 10, endLine: 15, snippet: "Keyword match" },
    ]);

    expect(output).toContain("[1] notes.md:10-15");
    expect(output).not.toContain("score:");
  });

  it("returns no-match message when empty", () => {
    const output = formatResults([]);
    expect(output).toContain("No memory content found");
  });

  it("prepends notice when provided", () => {
    const output = formatResults([], "Notice: ");
    expect(output.startsWith("Notice: ")).toBe(true);

    const output2 = formatResults(
      [{ path: "a.md", startLine: 1, endLine: 1, snippet: "x" }],
      "[fallback] ",
    );
    expect(output2.startsWith("[fallback] ")).toBe(true);
  });

  it("separates multiple results with dividers", () => {
    const output = formatResults([
      { path: "a.md", startLine: 1, endLine: 2, snippet: "First" },
      { path: "b.md", startLine: 3, endLine: 4, snippet: "Second" },
    ]);

    expect(output).toContain("---");
    expect(output).toContain("[1]");
    expect(output).toContain("[2]");
  });
});
