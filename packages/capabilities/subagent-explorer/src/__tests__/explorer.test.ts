import { describe, expect, it } from "vitest";
import { explorer, filterReadOnlyTools, isReadOnlyTool } from "../explorer.js";

describe("explorer mode factory", () => {
  it("returns a valid Mode shape", () => {
    const mode = explorer();

    expect(mode.id).toBe("explorer");
    expect(mode.name).toBe("Explorer");
    expect(mode.description).toBeTruthy();
    expect(typeof mode.systemPromptOverride).toBe("function");
    expect(mode.tools).toBeUndefined();
    expect(mode.model).toBeUndefined();
  });

  it("systemPromptOverride function form receives base prompt and returns rewritten prompt", () => {
    const mode = explorer();
    const override = mode.systemPromptOverride;
    const out =
      typeof override === "function" ? override("Parent prompt here", {} as any) : (override ?? "");

    expect(out).toContain("READ-ONLY");
    expect(out).toContain("Parent prompt here");
  });

  it("accepts model override", () => {
    const mode = explorer({ model: "google/gemini-2.5-flash" });
    expect(mode.model).toBe("google/gemini-2.5-flash");
  });

  it("wraps custom tool list in an allow filter", () => {
    const mode = explorer({ tools: ["file_read", "custom_search"] });
    expect(mode.tools).toEqual({ allow: ["file_read", "custom_search"] });
  });

  it("no model override by default", () => {
    const mode = explorer();
    expect(mode.model).toBeUndefined();
  });
});

describe("isReadOnlyTool", () => {
  it("identifies read-only tool names", () => {
    expect(isReadOnlyTool("file_read")).toBe(true);
    expect(isReadOnlyTool("file_list")).toBe(true);
    expect(isReadOnlyTool("grep")).toBe(true);
    expect(isReadOnlyTool("glob")).toBe(true);
    expect(isReadOnlyTool("file_find")).toBe(true);
    expect(isReadOnlyTool("file_tree")).toBe(true);
    expect(isReadOnlyTool("tavily_search")).toBe(true);
    expect(isReadOnlyTool("get_status")).toBe(true);
    expect(isReadOnlyTool("show_preview")).toBe(true);
    expect(isReadOnlyTool("check_task")).toBe(true);
  });

  it("rejects write tool names", () => {
    expect(isReadOnlyTool("file_write")).toBe(false);
    expect(isReadOnlyTool("file_edit")).toBe(false);
    expect(isReadOnlyTool("file_delete")).toBe(false);
    expect(isReadOnlyTool("file_copy")).toBe(false);
    expect(isReadOnlyTool("file_move")).toBe(false);
    expect(isReadOnlyTool("exec")).toBe(false);
    expect(isReadOnlyTool("elevate")).toBe(false);
    expect(isReadOnlyTool("create_agent")).toBe(false);
  });
});

describe("filterReadOnlyTools", () => {
  it("filters to read-only tools", () => {
    const tools = [
      "file_read",
      "file_write",
      "file_edit",
      "file_list",
      "grep",
      "exec",
      "file_tree",
      "elevate",
    ];

    const readOnly = filterReadOnlyTools(tools);

    expect(readOnly).toEqual(["file_read", "file_list", "grep", "file_tree"]);
  });

  it("returns empty for all-write tools", () => {
    expect(filterReadOnlyTools(["exec", "elevate", "file_write"])).toEqual([]);
  });

  it("returns all for all-read tools", () => {
    const tools = ["file_read", "grep", "file_list"];
    expect(filterReadOnlyTools(tools)).toEqual(tools);
  });
});
