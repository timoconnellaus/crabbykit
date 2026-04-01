import { describe, expect, it } from "vitest";
import { createMemoryGetTool } from "../memory-get.js";
import { createMockR2Bucket } from "./mock-r2.js";

const TOOL_CTX = { toolCallId: "test" };

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return (result.content[0] as { text: string }).text;
}

describe("memory_get tool", () => {
  it("reads a file successfully", async () => {
    const bucket = createMockR2Bucket({
      "agent-1/MEMORY.md": "# Memory\n\nHello world",
    });
    const tool = createMemoryGetTool(
      () => bucket,
      () => "agent-1",
    );

    const result = await tool.execute({ path: "MEMORY.md" }, TOOL_CTX);
    expect(textOf(result)).toBe("# Memory\n\nHello world");
  });

  it("returns error for empty path", async () => {
    const bucket = createMockR2Bucket();
    const tool = createMemoryGetTool(() => bucket, () => "agent-1");

    const result = await tool.execute({ path: "" }, TOOL_CTX);
    expect(textOf(result)).toContain("Error:");
    expect(textOf(result)).toContain("Path cannot be empty");
  });

  it("rejects path with ..", async () => {
    const bucket = createMockR2Bucket();
    const tool = createMemoryGetTool(() => bucket, () => "agent-1");

    const result = await tool.execute({ path: "../etc/passwd" }, TOOL_CTX);
    expect(textOf(result)).toContain("cannot contain '..'");
  });

  it("rejects absolute path", async () => {
    const bucket = createMockR2Bucket();
    const tool = createMemoryGetTool(() => bucket, () => "agent-1");

    const result = await tool.execute({ path: "/etc/passwd" }, TOOL_CTX);
    expect(textOf(result)).toContain("must be relative");
  });

  it("rejects path with null bytes", async () => {
    const bucket = createMockR2Bucket();
    const tool = createMemoryGetTool(() => bucket, () => "agent-1");

    const result = await tool.execute({ path: "file\0.md" }, TOOL_CTX);
    expect(textOf(result)).toContain("null bytes");
  });

  it("rejects path exceeding 512 chars", async () => {
    const bucket = createMockR2Bucket();
    const tool = createMemoryGetTool(() => bucket, () => "agent-1");

    const result = await tool.execute({ path: "a".repeat(513) }, TOOL_CTX);
    expect(textOf(result)).toContain("exceeds maximum length");
  });

  it("returns error for non-existent file", async () => {
    const bucket = createMockR2Bucket();
    const tool = createMemoryGetTool(() => bucket, () => "agent-1");

    const result = await tool.execute({ path: "missing.md" }, TOOL_CTX);
    expect(textOf(result)).toContain("File not found");
  });

  it("applies offset parameter", async () => {
    const content = "line0\nline1\nline2\nline3\nline4";
    const bucket = createMockR2Bucket({ "agent-1/notes.md": content });
    const tool = createMemoryGetTool(() => bucket, () => "agent-1");

    const result = await tool.execute({ path: "notes.md", offset: 2 }, TOOL_CTX);
    expect(textOf(result)).toBe("line2\nline3\nline4");
  });

  it("applies offset + lines parameters", async () => {
    const content = "line0\nline1\nline2\nline3\nline4";
    const bucket = createMockR2Bucket({ "agent-1/notes.md": content });
    const tool = createMemoryGetTool(() => bucket, () => "agent-1");

    const result = await tool.execute(
      { path: "notes.md", offset: 1, lines: 2 },
      TOOL_CTX,
    );
    expect(textOf(result)).toBe("line1\nline2");
  });

  it("clamps offset beyond file length", async () => {
    const content = "line0\nline1";
    const bucket = createMockR2Bucket({ "agent-1/test.md": content });
    const tool = createMemoryGetTool(() => bucket, () => "agent-1");

    const result = await tool.execute({ path: "test.md", offset: 100 }, TOOL_CTX);
    expect(textOf(result)).toBe("");
  });

  it("truncates content exceeding maxReadBytes", async () => {
    const longContent = Array.from({ length: 200 }, (_, i) => `Line ${i}`).join("\n");
    const bucket = createMockR2Bucket({ "agent-1/big.md": longContent });
    // Use a small maxReadBytes to trigger truncation
    const tool = createMemoryGetTool(() => bucket, () => "agent-1", 100);

    const result = await tool.execute({ path: "big.md" }, TOOL_CTX);
    const text = textOf(result);
    expect(text).toContain("[Truncated");
    expect(text).toContain("100 bytes");
  });

  it("returns details with path and byteLength", async () => {
    const bucket = createMockR2Bucket({ "agent-1/MEMORY.md": "Hello" });
    const tool = createMemoryGetTool(() => bucket, () => "agent-1");

    const result = await tool.execute({ path: "MEMORY.md" }, TOOL_CTX);
    expect(result.details).toEqual({ path: "MEMORY.md", byteLength: 5 });
  });
});
