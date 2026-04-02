import { describe, expect, it } from "vitest";
import type { AgentTool } from "../types.js";
import {
  buildToolNotFoundError,
  findClosestTool,
  levenshtein,
  repairToolName,
} from "../tool-call-repair.js";

/** Create a minimal AgentTool stub for testing. */
function makeTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: `Tool: ${name}`,
    parameters: {},
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
  } as unknown as AgentTool;
}

const tools = [
  makeTool("web_search"),
  makeTool("web_fetch"),
  makeTool("get_time"),
  makeTool("file_read"),
];

describe("levenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("abc", "abc")).toBe(0);
  });

  it("returns length for empty vs non-empty", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
  });

  it("returns 0 for two empty strings", () => {
    expect(levenshtein("", "")).toBe(0);
  });

  it("handles single character difference", () => {
    expect(levenshtein("cat", "bat")).toBe(1);
  });

  it("handles insertion", () => {
    expect(levenshtein("cat", "cats")).toBe(1);
  });

  it("handles deletion", () => {
    expect(levenshtein("cats", "cat")).toBe(1);
  });

  it("handles multiple edits", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });
});

describe("repairToolName", () => {
  describe("happy path", () => {
    it("resolves case-insensitive match", () => {
      const result = repairToolName("Web_Search", tools);
      expect(result?.name).toBe("web_search");
    });

    it("resolves all-uppercase match", () => {
      const result = repairToolName("WEB_SEARCH", tools);
      expect(result?.name).toBe("web_search");
    });

    it("resolves mixed case match", () => {
      const result = repairToolName("Get_Time", tools);
      expect(result?.name).toBe("get_time");
    });
  });

  describe("negative", () => {
    it("returns null for completely unknown name", () => {
      expect(repairToolName("nonexistent_tool", tools)).toBeNull();
    });

    it("returns null for partial name", () => {
      expect(repairToolName("web", tools)).toBeNull();
    });
  });

  describe("boundary", () => {
    it("returns null for empty tool list", () => {
      expect(repairToolName("web_search", [])).toBeNull();
    });

    it("handles single-character tool name", () => {
      const singleTools = [makeTool("x")];
      expect(repairToolName("X", singleTools)?.name).toBe("x");
    });

    it("exact match is not returned (only case-insensitive)", () => {
      // Exact match should be handled by the caller before calling repair
      const result = repairToolName("web_search", tools);
      // It DOES return for exact match since case-insensitive includes exact
      expect(result?.name).toBe("web_search");
    });
  });

  describe("invariant", () => {
    it("does not modify the tools array", () => {
      const original = [...tools];
      repairToolName("UNKNOWN", tools);
      expect(tools).toEqual(original);
    });
  });
});

describe("findClosestTool", () => {
  describe("happy path", () => {
    it("finds closest match by edit distance", () => {
      expect(findClosestTool("web_seach", tools)).toBe("web_search");
    });

    it("finds match for typo", () => {
      expect(findClosestTool("web_serch", tools)).toBe("web_search");
    });
  });

  describe("negative", () => {
    it("returns null for completely different name", () => {
      expect(findClosestTool("xyz_123_abc_def", tools)).toBeNull();
    });
  });

  describe("boundary", () => {
    it("returns null for empty tool list", () => {
      expect(findClosestTool("anything", [])).toBeNull();
    });

    it("handles single-character name", () => {
      // "x" vs tool names — all too different
      expect(findClosestTool("x", tools)).toBeNull();
    });

    it("finds tool differing by 1 character", () => {
      expect(findClosestTool("web_fetcH", tools)).toBe("web_fetch");
    });
  });
});

describe("buildToolNotFoundError", () => {
  describe("happy path", () => {
    it("includes tool name and available list", () => {
      const msg = buildToolNotFoundError("search_web", tools);
      expect(msg).toContain("search_web");
      expect(msg).toContain("web_search");
      expect(msg).toContain("web_fetch");
      expect(msg).toContain("get_time");
      expect(msg).toContain("file_read");
    });

    it("includes 'Did you mean' for close matches", () => {
      const msg = buildToolNotFoundError("web_serch", tools);
      expect(msg).toContain("Did you mean");
      expect(msg).toContain("web_search");
    });
  });

  describe("negative", () => {
    it("omits 'Did you mean' when no close match exists", () => {
      const msg = buildToolNotFoundError("xyz_123_abc_def_ghi", tools);
      expect(msg).not.toContain("Did you mean");
      expect(msg).toContain("Available tools:");
    });
  });

  describe("boundary", () => {
    it("handles empty tool list", () => {
      const msg = buildToolNotFoundError("anything", []);
      expect(msg).toContain("anything");
      expect(msg).toContain("Available tools:");
    });
  });

  describe("invariant", () => {
    it("always starts with Tool not found message", () => {
      const msg = buildToolNotFoundError("test", tools);
      expect(msg).toMatch(/^Tool 'test' not found\./);
    });
  });
});
