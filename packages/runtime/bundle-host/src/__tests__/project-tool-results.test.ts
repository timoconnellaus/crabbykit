/**
 * bundle-lifecycle-hooks — `projectToolResultsForBundle` unit tests.
 */

import { describe, expect, it, vi } from "vitest";
import { projectToolResultsForBundle } from "../serialization.js";

describe("projectToolResultsForBundle", () => {
  it("projects a clean two-result array unchanged", () => {
    const results = [
      { toolName: "search", args: { q: "x" }, content: "ok", isError: false },
      { toolName: "fetch", args: null, content: "done", isError: false },
    ];
    const projected = projectToolResultsForBundle(results);
    expect(projected).toEqual(results);
  });

  it("substitutes sentinel when entry contains a function reference", () => {
    const onFail = vi.fn();
    const results = [
      { toolName: "ok-tool", args: null, content: "ok", isError: false },
      { toolName: "bad-tool", args: null, content: () => "lazy", isError: false },
    ];
    const projected = projectToolResultsForBundle(results, onFail);
    expect(projected[0]).toEqual({
      toolName: "ok-tool",
      args: null,
      content: "ok",
      isError: false,
    });
    expect(projected[1]).toEqual({
      toolName: "unknown",
      args: null,
      content: "<projection failed>",
      isError: true,
    });
    expect(onFail).toHaveBeenCalledWith(1, expect.any(String));
  });

  it("substitutes sentinel for class-instance entries", () => {
    class StreamReader {}
    const results = [{ toolName: "x", args: new StreamReader(), content: "", isError: false }];
    const projected = projectToolResultsForBundle(results);
    expect(projected[0]?.toolName).toBe("unknown");
    expect(projected[0]?.content).toBe("<projection failed>");
  });

  it("concats text content-blocks to a string", () => {
    const results = [
      {
        toolName: "x",
        args: null,
        content: [
          { type: "text", text: "hello " },
          { type: "text", text: "world" },
        ],
        isError: false,
      },
    ];
    const projected = projectToolResultsForBundle(results);
    expect(projected[0]?.content).toBe("hello world");
  });

  it("returns empty array for non-array input", () => {
    expect(projectToolResultsForBundle(null as unknown as unknown[])).toEqual([]);
    expect(projectToolResultsForBundle(undefined as unknown as unknown[])).toEqual([]);
  });

  it("handles null entries by substituting sentinel", () => {
    const projected = projectToolResultsForBundle([null, undefined]);
    expect(projected).toHaveLength(2);
    expect(projected.every((p) => p.toolName === "unknown")).toBe(true);
  });
});
