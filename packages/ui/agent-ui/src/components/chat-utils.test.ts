import { describe, expect, it } from "vitest";
import {
  formatDuration,
  summarizeResult,
  summarizeToolInput,
  toolColorCategory,
} from "./chat-utils";

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------
describe("formatDuration", () => {
  it("returns milliseconds for < 1000ms", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("returns seconds with one decimal for >= 1000ms", () => {
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(12345)).toBe("12.3s");
  });
});

// ---------------------------------------------------------------------------
// summarizeToolInput
// ---------------------------------------------------------------------------
describe("summarizeToolInput", () => {
  it("returns empty string for falsy input", () => {
    expect(summarizeToolInput(null)).toBe("");
    expect(summarizeToolInput(undefined)).toBe("");
    expect(summarizeToolInput("")).toBe("");
    expect(summarizeToolInput(0)).toBe("");
  });

  it("returns short strings as-is", () => {
    expect(summarizeToolInput("hello world")).toBe("hello world");
  });

  it("truncates long strings at 60 chars", () => {
    const long = "a".repeat(80);
    const result = summarizeToolInput(long);
    expect(result).toBe(`${"a".repeat(57)}...`);
    expect(result.length).toBe(60);
  });

  it("parses JSON string input recursively", () => {
    const json = JSON.stringify({ agentId: "a1", agentName: "Bot", message: "hi" });
    expect(summarizeToolInput(json)).toBe("Bot \u00b7 hi");
  });

  it("treats unparseable strings as plain text", () => {
    expect(summarizeToolInput("not json {")).toBe("not json {");
  });

  // agent_message pattern
  it("shows agentName + message preview for agent messages", () => {
    expect(summarizeToolInput({ agentId: "a1", agentName: "Bot", message: "hello" })).toBe(
      "Bot \u00b7 hello",
    );
  });

  it("falls back to agentId when agentName is missing", () => {
    expect(summarizeToolInput({ agentId: "agent-42", message: "hello" })).toBe(
      "agent-42 \u00b7 hello",
    );
  });

  it("truncates long agent messages at 50 chars", () => {
    const msg = "x".repeat(60);
    const result = summarizeToolInput({ agentId: "a", agentName: "B", message: msg });
    expect(result).toBe(`B \u00b7 ${"x".repeat(47)}...`);
  });

  // start_process pattern
  it("shows name + command for process tools", () => {
    expect(summarizeToolInput({ name: "dev", command: "bun dev" })).toBe("dev \u00b7 bun dev");
  });

  it("truncates long commands at 50 chars", () => {
    const cmd = "c".repeat(60);
    const result = summarizeToolInput({ name: "build", command: cmd });
    expect(result).toBe(`build \u00b7 ${"c".repeat(47)}...`);
  });

  // namespace pattern
  it("shows namespace + value for config objects", () => {
    expect(summarizeToolInput({ namespace: "theme", value: "dark" })).toBe("theme \u00b7 dark");
  });

  it("stringifies non-string values", () => {
    expect(summarizeToolInput({ namespace: "limits", value: { max: 100 } })).toBe(
      'limits \u00b7 {"max":100}',
    );
  });

  it("truncates long values at 40 chars", () => {
    const val = "v".repeat(50);
    const result = summarizeToolInput({ namespace: "ns", value: val });
    expect(result).toBe(`ns \u00b7 ${"v".repeat(37)}...`);
  });

  it("shows namespace alone when no value", () => {
    expect(summarizeToolInput({ namespace: "cache" })).toBe("cache");
  });

  // generic object fallback
  it("shows first non-empty string value from object", () => {
    expect(summarizeToolInput({ foo: 123, bar: "hello" })).toBe("hello");
  });

  it("truncates long first-string value at 60 chars", () => {
    const long = "z".repeat(80);
    expect(summarizeToolInput({ key: long })).toBe(`${"z".repeat(57)}...`);
  });

  it("returns empty string for object with no string values", () => {
    expect(summarizeToolInput({ a: 1, b: true })).toBe("");
  });
});

// ---------------------------------------------------------------------------
// toolColorCategory
// ---------------------------------------------------------------------------
describe("toolColorCategory", () => {
  it("maps bash tools", () => {
    expect(toolColorCategory("bash")).toBe("bash");
    expect(toolColorCategory("start_process")).toBe("bash");
  });

  it("maps code tools", () => {
    expect(toolColorCategory("run_code")).toBe("code");
  });

  it("maps web tools", () => {
    expect(toolColorCategory("web_search")).toBe("web");
    expect(toolColorCategory("web_fetch")).toBe("web");
  });

  it("maps memory tools", () => {
    expect(toolColorCategory("memory_read")).toBe("memory");
    expect(toolColorCategory("memory_write")).toBe("memory");
    expect(toolColorCategory("memory_search")).toBe("memory");
    expect(toolColorCategory("memory_get")).toBe("memory");
  });

  it("maps exec and sandbox tools to bash", () => {
    expect(toolColorCategory("exec")).toBe("bash");
    expect(toolColorCategory("elevate")).toBe("bash");
    expect(toolColorCategory("de_elevate")).toBe("bash");
    expect(toolColorCategory("process")).toBe("bash");
  });

  it("maps file tools", () => {
    expect(toolColorCategory("file_read")).toBe("file");
    expect(toolColorCategory("file_write")).toBe("file");
    expect(toolColorCategory("file_edit")).toBe("file");
    expect(toolColorCategory("file_tree")).toBe("file");
  });

  it("maps preview and deploy tools", () => {
    expect(toolColorCategory("show_preview")).toBe("preview");
    expect(toolColorCategory("deploy_app")).toBe("preview");
    expect(toolColorCategory("get_console_logs")).toBe("preview");
  });

  it("returns default for unknown tools", () => {
    expect(toolColorCategory("custom_tool")).toBe("default");
  });
});

// ---------------------------------------------------------------------------
// summarizeResult
// ---------------------------------------------------------------------------
describe("summarizeResult", () => {
  // Error cases
  describe("error results", () => {
    it("extracts error type from errorText", () => {
      const r = summarizeResult("bash", "", true, "TypeError: cannot read property");
      expect(r).toEqual({ text: "TypeError", variant: "error" });
    });

    it("extracts exit code from errorText", () => {
      const r = summarizeResult("bash", "", true, "exit code 1 — command failed");
      expect(r).toEqual({ text: "exit code 1", variant: "error" });
    });

    it("truncates long error text at 40 chars", () => {
      const long = "x".repeat(60);
      const r = summarizeResult("bash", "", true, long);
      expect(r!.text).toBe(long.slice(0, 40));
      expect(r!.variant).toBe("error");
    });

    it("returns generic error when no errorText", () => {
      expect(summarizeResult("bash", "", true)).toEqual({ text: "error", variant: "error" });
    });
  });

  // Null output
  it("returns null for falsy output", () => {
    expect(summarizeResult("bash", null, false)).toBeNull();
    expect(summarizeResult("bash", "", false)).toBeNull();
    expect(summarizeResult("bash", undefined, false)).toBeNull();
  });

  // bash / start_process
  describe("bash / start_process", () => {
    it("detects 'added N packages'", () => {
      expect(summarizeResult("bash", "added 42 packages in 3s", false)).toEqual({
        text: "added 42 packages",
        variant: "success",
      });
    });

    it("detects 'N passed' test results", () => {
      expect(summarizeResult("bash", "10 passed", false)).toEqual({
        text: "10 passed",
        variant: "success",
      });
    });

    it("detects 'N passed · M failed'", () => {
      expect(summarizeResult("bash", "8 passed\n2 failed", false)).toEqual({
        text: "8 passed \u00b7 2 failed",
        variant: "success",
      });
    });

    it("detects non-zero exit code", () => {
      expect(summarizeResult("start_process", "exit code 2", false)).toEqual({
        text: "exit code 2",
        variant: "error",
      });
    });

    it("ignores exit code 0", () => {
      // exit code 0 should not match the non-zero check
      const r = summarizeResult("bash", "exit code 0", false);
      expect(r?.variant).not.toBe("error");
    });

    it("detects 'built in' pattern", () => {
      expect(summarizeResult("bash", "built in 1.2s", false)).toEqual({
        text: "built in 1.2s",
        variant: "success",
      });
    });

    it("detects 'N files changed'", () => {
      expect(summarizeResult("bash", "3 files changed", false)).toEqual({
        text: "3 changed",
        variant: "muted",
      });
    });

    it("shows single-line output directly", () => {
      expect(summarizeResult("bash", "hello world", false)).toEqual({
        text: "hello world",
        variant: "muted",
      });
    });

    it("shows line count for multi-line output", () => {
      expect(summarizeResult("bash", "line1\nline2\nline3", false)).toEqual({
        text: "3 lines",
        variant: "muted",
      });
    });

    it("returns null for empty string output after splitting", () => {
      // A string of only newlines
      expect(summarizeResult("bash", "\n\n", false)).toBeNull();
    });
  });

  // run_code
  describe("run_code", () => {
    it("shows item count for array result (object)", () => {
      expect(summarizeResult("run_code", [1, 2, 3], false)).toEqual({
        text: "\u2192 3 items",
        variant: "success",
      });
    });

    it("shows 'ok' for { ok: true }", () => {
      expect(summarizeResult("run_code", { ok: true }, false)).toEqual({
        text: "\u2192 ok",
        variant: "success",
      });
    });

    it("shows error for { ok: false, error: ... }", () => {
      expect(summarizeResult("run_code", { ok: false, error: "boom" }, false)).toEqual({
        text: "boom",
        variant: "error",
      });
    });

    it("shows generic failed for { ok: false } without error", () => {
      expect(summarizeResult("run_code", { ok: false }, false)).toEqual({
        text: "\u2192 failed",
        variant: "error",
      });
    });

    it("shows result field if present", () => {
      expect(summarizeResult("run_code", { result: 42 }, false)).toEqual({
        text: "\u2192 42",
        variant: "success",
      });
    });

    it("truncates long result field", () => {
      const long = "r".repeat(50);
      const r = summarizeResult("run_code", { result: long }, false);
      expect(r!.text).toBe(`\u2192 ${"r".repeat(37)}...`);
    });

    it("parses JSON string input", () => {
      expect(summarizeResult("run_code", JSON.stringify([1, 2]), false)).toEqual({
        text: "\u2192 2 items",
        variant: "success",
      });
    });

    it("handles unparseable string output", () => {
      expect(summarizeResult("run_code", "just text", false)).toEqual({
        text: "\u2192 just text",
        variant: "success",
      });
    });

    it("truncates long string output", () => {
      const long = "x".repeat(60);
      const r = summarizeResult("run_code", long, false);
      expect(r!.text).toBe(`\u2192 ${"x".repeat(40)}...`);
    });
  });

  // file_read
  describe("file_read", () => {
    it("counts lines", () => {
      expect(summarizeResult("file_read", "a\nb\nc", false)).toEqual({
        text: "3 lines",
        variant: "muted",
      });
    });
  });

  // file_write / file_edit
  describe("file_write / file_edit", () => {
    it("counts added and removed lines (diff format)", () => {
      const diff = "--- a/file\n+++ b/file\n+added\n-removed\n+also added";
      expect(summarizeResult("file_write", diff, false)).toEqual({
        text: "+2 -1",
        variant: "success",
      });
    });

    it("shows only removes with error variant", () => {
      const diff = "--- a/file\n+++ b/file\n-gone\n-also gone";
      expect(summarizeResult("file_edit", diff, false)).toEqual({
        text: "-2",
        variant: "error",
      });
    });

    it("shows line count for non-diff multi-line content", () => {
      expect(summarizeResult("file_write", "line1\nline2\nline3", false)).toEqual({
        text: "created \u00b7 3 lines",
        variant: "success",
      });
    });

    it("shows 'written' for single-line non-diff content", () => {
      expect(summarizeResult("file_write", "ok", false)).toEqual({
        text: "written",
        variant: "success",
      });
    });
  });

  // file_list
  describe("file_list", () => {
    it("counts files", () => {
      expect(summarizeResult("file_list", "a.ts\nb.ts\nc.ts", false)).toEqual({
        text: "3 files",
        variant: "muted",
      });
    });

    it("filters empty lines", () => {
      expect(summarizeResult("file_list", "a.ts\n\nb.ts\n", false)).toEqual({
        text: "2 files",
        variant: "muted",
      });
    });
  });

  // file_tree
  describe("file_tree", () => {
    it("counts files and dirs separately", () => {
      expect(summarizeResult("file_tree", "src/\nfoo.ts\nbar.ts", false)).toEqual({
        text: "2 files \u00b7 1 dirs",
        variant: "muted",
      });
    });

    it("shows only files when no dirs", () => {
      expect(summarizeResult("file_tree", "a.ts\nb.ts", false)).toEqual({
        text: "2 files",
        variant: "muted",
      });
    });

    it("shows only dirs when no files", () => {
      expect(summarizeResult("file_tree", "src/\nlib/", false)).toEqual({
        text: "2 dirs",
        variant: "muted",
      });
    });

    it("falls back to entries count when both are zero", () => {
      // All empty lines filtered out → 0 entries
      expect(summarizeResult("file_tree", "\n\n", false)).toEqual({
        text: "0 entries",
        variant: "muted",
      });
    });
  });

  // file_find
  describe("file_find", () => {
    it("counts matches", () => {
      expect(summarizeResult("file_find", "a.ts\nb.ts", false)).toEqual({
        text: "2 matches",
        variant: "muted",
      });
    });

    it("shows 'no matches' for empty result", () => {
      expect(summarizeResult("file_find", "\n", false)).toEqual({
        text: "no matches",
        variant: "muted",
      });
    });
  });

  // web_search
  describe("web_search", () => {
    it("counts results from object with results array", () => {
      expect(summarizeResult("web_search", { results: [1, 2, 3] }, false)).toEqual({
        text: "3 results",
        variant: "muted",
      });
    });

    it("parses JSON string with results array", () => {
      expect(summarizeResult("web_search", JSON.stringify({ results: [1] }), false)).toEqual({
        text: "1 results",
        variant: "muted",
      });
    });

    it("extracts count from text pattern", () => {
      expect(summarizeResult("web_search", "Found 5 results for query", false)).toEqual({
        text: "5 results",
        variant: "muted",
      });
    });

    it("returns generic 'results' as fallback", () => {
      expect(summarizeResult("web_search", "some output", false)).toEqual({
        text: "results",
        variant: "muted",
      });
    });
  });

  // web_fetch
  describe("web_fetch", () => {
    it("extracts markdown title", () => {
      expect(summarizeResult("web_fetch", "# My Page\nContent here", false)).toEqual({
        text: "My Page",
        variant: "muted",
      });
    });

    it("extracts HTML title", () => {
      expect(
        summarizeResult("web_fetch", "<html><title>Hello World</title></html>", false),
      ).toEqual({
        text: "Hello World",
        variant: "muted",
      });
    });

    it("truncates long titles at 40 chars", () => {
      const title = "T".repeat(60);
      const r = summarizeResult("web_fetch", `# ${title}\nBody`, false);
      expect(r!.text).toBe("T".repeat(40));
    });

    it("shows kb size when no title found", () => {
      const content = "x".repeat(2048);
      expect(summarizeResult("web_fetch", content, false)).toEqual({
        text: "2.0kb",
        variant: "muted",
      });
    });
  });

  // memory_search
  describe("memory_search", () => {
    it("shows count for non-empty array (object)", () => {
      expect(summarizeResult("memory_search", [1, 2], false)).toEqual({
        text: "2 memories",
        variant: "muted",
      });
    });

    it("shows 'no results' for empty array", () => {
      expect(summarizeResult("memory_search", [], false)).toEqual({
        text: "no results",
        variant: "muted",
      });
    });

    it("parses JSON string array", () => {
      expect(summarizeResult("memory_search", JSON.stringify([1]), false)).toEqual({
        text: "1 memories",
        variant: "muted",
      });
    });

    it("detects 'no' in text output", () => {
      expect(summarizeResult("memory_search", "no matching memories", false)).toEqual({
        text: "no results",
        variant: "muted",
      });
    });

    it("returns 'retrieved' as fallback", () => {
      expect(summarizeResult("memory_search", "some data", false)).toEqual({
        text: "retrieved",
        variant: "muted",
      });
    });
  });

  // memory_get
  describe("memory_get", () => {
    it("returns 'not found' for null-like output", () => {
      expect(summarizeResult("memory_get", "null", false)).toEqual({
        text: "not found",
        variant: "muted",
      });
    });

    it("returns 'retrieved' for non-null output", () => {
      expect(summarizeResult("memory_get", "some content", false)).toEqual({
        text: "retrieved",
        variant: "muted",
      });
    });
  });

  // elevate / de_elevate
  describe("sandbox tools", () => {
    it("elevate shows activation", () => {
      expect(summarizeResult("elevate", "ok", false)).toEqual({
        text: "sandbox activated",
        variant: "success",
      });
    });

    it("de_elevate shows deactivation", () => {
      expect(summarizeResult("de_elevate", "ok", false)).toEqual({
        text: "sandbox deactivated",
        variant: "muted",
      });
    });
  });

  // default tool
  describe("default (unknown tools)", () => {
    it("shows 'done' for empty output", () => {
      expect(summarizeResult("custom_tool", "\n\n", false)).toEqual({
        text: "done",
        variant: "muted",
      });
    });

    it("shows single short line directly", () => {
      expect(summarizeResult("custom_tool", "success", false)).toEqual({
        text: "success",
        variant: "muted",
      });
    });

    it("shows line count for multi-line output", () => {
      expect(summarizeResult("custom_tool", "a\nb\nc", false)).toEqual({
        text: "3 lines",
        variant: "muted",
      });
    });

    it("shows line count for single long line", () => {
      const long = "x".repeat(60);
      expect(summarizeResult("custom_tool", long, false)).toEqual({
        text: "1 lines",
        variant: "muted",
      });
    });
  });
});
