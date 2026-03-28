import { describe, expect, it } from "vitest";
import { globToRegex, resolveListPrefix, toR2Key, validatePath } from "../paths.js";

describe("validatePath", () => {
  it("accepts a simple path", () => {
    const result = validatePath("src/main.ts");
    expect(result).toEqual({ valid: true, normalizedPath: "src/main.ts" });
  });

  it("strips leading slashes", () => {
    const result = validatePath("/src/main.ts");
    expect(result).toEqual({ valid: true, normalizedPath: "src/main.ts" });
  });

  it("strips leading ./", () => {
    const result = validatePath("./src/main.ts");
    expect(result).toEqual({ valid: true, normalizedPath: "src/main.ts" });
  });

  it("normalizes backslashes", () => {
    const result = validatePath("src\\lib\\utils.ts");
    expect(result).toEqual({ valid: true, normalizedPath: "src/lib/utils.ts" });
  });

  it("rejects paths with .. segments", () => {
    const result = validatePath("src/../etc/passwd");
    expect(result).toEqual({ valid: false, error: "Path must not contain '..' segments" });
  });

  it("rejects paths with null bytes", () => {
    const result = validatePath("src/\0evil");
    expect(result).toEqual({ valid: false, error: "Path must not contain null bytes" });
  });

  it("rejects bare .", () => {
    const result = validatePath(".");
    expect(result).toEqual({ valid: false, error: "Path must not be empty after normalization" });
  });

  it("rejects empty string after normalization", () => {
    const result = validatePath("/");
    expect(result).toEqual({ valid: false, error: "Path must not be empty after normalization" });
  });

  it("rejects paths exceeding 512 bytes", () => {
    const longPath = "a".repeat(513);
    const result = validatePath(longPath);
    expect(result).toEqual({ valid: false, error: "Path must not exceed 512 bytes" });
  });

  it("accepts paths at exactly 512 bytes", () => {
    const exactPath = "a".repeat(512);
    const result = validatePath(exactPath);
    expect(result).toEqual({ valid: true, normalizedPath: exactPath });
  });
});

describe("toR2Key", () => {
  it("prefixes the path", () => {
    expect(toR2Key("agent-123", "src/main.ts")).toBe("agent-123/src/main.ts");
  });
});

describe("resolveListPrefix", () => {
  it("returns root prefix for undefined path", () => {
    expect(resolveListPrefix(undefined, "agent-1")).toEqual({ prefix: "agent-1/" });
  });

  it("returns root prefix for empty path", () => {
    expect(resolveListPrefix("", "agent-1")).toEqual({ prefix: "agent-1/" });
  });

  it("returns root prefix for dot", () => {
    expect(resolveListPrefix(".", "agent-1")).toEqual({ prefix: "agent-1/" });
  });

  it("returns prefixed path for valid directory", () => {
    expect(resolveListPrefix("src/lib", "agent-1")).toEqual({ prefix: "agent-1/src/lib/" });
  });

  it("returns error for invalid path", () => {
    expect(resolveListPrefix("../etc", "agent-1")).toEqual({
      error: "Path must not contain '..' segments",
    });
  });
});

describe("globToRegex", () => {
  it("matches ** across directories", () => {
    const re = globToRegex("**/*.ts");
    expect(re.test("src/main.ts")).toBe(true);
    expect(re.test("src/lib/utils.ts")).toBe(true);
    expect(re.test("main.ts")).toBe(true);
    expect(re.test("main.js")).toBe(false);
  });

  it("matches * within a single directory", () => {
    const re = globToRegex("src/*.ts");
    expect(re.test("src/main.ts")).toBe(true);
    expect(re.test("src/lib/main.ts")).toBe(false);
  });

  it("matches ? as single character", () => {
    const re = globToRegex("file?.txt");
    expect(re.test("file1.txt")).toBe(true);
    expect(re.test("fileAB.txt")).toBe(false);
  });

  it("escapes regex special characters", () => {
    const re = globToRegex("package.json");
    expect(re.test("package.json")).toBe(true);
    expect(re.test("packageXjson")).toBe(false);
  });

  it("handles ** followed by /", () => {
    const re = globToRegex("src/**/index.ts");
    expect(re.test("src/index.ts")).toBe(true);
    expect(re.test("src/lib/index.ts")).toBe(true);
    expect(re.test("src/a/b/c/index.ts")).toBe(true);
  });
});
