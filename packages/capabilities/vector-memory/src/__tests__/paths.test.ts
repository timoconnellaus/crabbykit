import { describe, expect, it } from "vitest";
import { isMemoryPath } from "../paths.js";

describe("isMemoryPath", () => {
  it("matches MEMORY.md (case-insensitive)", () => {
    expect(isMemoryPath("MEMORY.md")).toBe(true);
    expect(isMemoryPath("memory.md")).toBe(true);
    expect(isMemoryPath("Memory.md")).toBe(true);
  });

  it("matches memory/*.md files", () => {
    expect(isMemoryPath("memory/notes.md")).toBe(true);
    expect(isMemoryPath("memory/2026-03-28.md")).toBe(true);
    expect(isMemoryPath("memory/deep/nested.md")).toBe(true);
  });

  it("rejects non-memory paths", () => {
    expect(isMemoryPath("README.md")).toBe(false);
    expect(isMemoryPath("src/index.ts")).toBe(false);
    expect(isMemoryPath("memory/notes.txt")).toBe(false);
    expect(isMemoryPath("other-memory.md")).toBe(false);
  });
});
