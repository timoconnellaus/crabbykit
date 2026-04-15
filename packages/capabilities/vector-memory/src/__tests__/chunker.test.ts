import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "../chunker.js";

describe("chunkMarkdown", () => {
  it("returns empty array for empty content", async () => {
    expect(await chunkMarkdown("")).toEqual([]);
    expect(await chunkMarkdown("   ")).toEqual([]);
    expect(await chunkMarkdown("\n\n\n")).toEqual([]);
  });

  it("returns single chunk for short content", async () => {
    const content = "Hello world\n\nThis is a test.";
    const chunks = await chunkMarkdown(content);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe("Hello world\n\nThis is a test.");
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("tracks 1-based line numbers", async () => {
    const content = "Line 1\n\nLine 3\n\nLine 5";
    const chunks = await chunkMarkdown(content);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].startLine).toBe(1);
  });

  it("produces stable hashes for same content", async () => {
    const content = "Stable content here.";
    const chunks1 = await chunkMarkdown(content);
    const chunks2 = await chunkMarkdown(content);

    expect(chunks1[0].hash).toBe(chunks2[0].hash);
  });

  it("produces different hashes for different content", async () => {
    const chunks1 = await chunkMarkdown("Content A");
    const chunks2 = await chunkMarkdown("Content B");

    expect(chunks1[0].hash).not.toBe(chunks2[0].hash);
  });

  it("splits long content into multiple chunks", async () => {
    // Create content longer than CHUNK_SIZE_CHARS (1600)
    const paragraphs: string[] = [];
    for (let i = 0; i < 20; i++) {
      paragraphs.push(`Paragraph ${i}: ${"x".repeat(150)}`);
    }
    const content = paragraphs.join("\n\n");

    const chunks = await chunkMarkdown(content);

    expect(chunks.length).toBeGreaterThan(1);

    // All chunks should have valid line numbers
    for (const chunk of chunks) {
      expect(chunk.startLine).toBeGreaterThanOrEqual(1);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
      expect(chunk.content.length).toBeGreaterThan(0);
      expect(chunk.hash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("creates overlap between consecutive chunks", async () => {
    // Create content that needs multiple chunks
    const paragraphs: string[] = [];
    for (let i = 0; i < 30; i++) {
      paragraphs.push(`Paragraph ${i}: ${"word ".repeat(40)}`);
    }
    const content = paragraphs.join("\n\n");

    const chunks = await chunkMarkdown(content);

    expect(chunks.length).toBeGreaterThan(1);

    // Check that consecutive chunks share some content (overlap)
    for (let i = 1; i < chunks.length; i++) {
      const prevContent = chunks[i - 1].content;
      const currContent = chunks[i].content;

      // The current chunk should start with text that was also at the end of the previous chunk
      // (due to paragraph-level overlap)
      const currFirstLine = currContent.split("\n")[0];
      expect(prevContent).toContain(currFirstLine);
    }
  });

  it("handles single very long paragraph", async () => {
    const content = "x".repeat(3000);
    const chunks = await chunkMarkdown(content);

    // Should still produce at least one chunk
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0].content.length).toBeGreaterThan(0);
  });
});
