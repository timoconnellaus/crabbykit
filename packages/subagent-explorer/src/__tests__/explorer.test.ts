import { describe, expect, it } from "vitest";
import { explorer, filterReadOnlyTools, isReadOnlyTool } from "../explorer.js";

describe("explorer profile", () => {
  it("returns a valid SubagentProfile", () => {
    const profile = explorer();

    expect(profile.id).toBe("explorer");
    expect(profile.name).toBe("Explorer");
    expect(profile.description).toBeTruthy();
    expect(typeof profile.systemPrompt).toBe("function");
    expect(profile.tools).toBeUndefined();
    expect(profile.model).toBeUndefined();
  });

  it("resolves system prompt with parent context", () => {
    const profile = explorer();
    const prompt =
      typeof profile.systemPrompt === "function"
        ? profile.systemPrompt("Parent prompt here")
        : profile.systemPrompt;

    expect(prompt).toContain("READ-ONLY");
    expect(prompt).toContain("Parent prompt here");
  });

  it("accepts model override", () => {
    const profile = explorer({ model: "google/gemini-2.5-flash" });
    expect(profile.model).toBe("google/gemini-2.5-flash");
  });

  it("accepts custom tools list", () => {
    const profile = explorer({ tools: ["file_read", "custom_search"] });
    expect(profile.tools).toEqual(["file_read", "custom_search"]);
  });

  it("no model override by default", () => {
    const profile = explorer();
    expect(profile.model).toBeUndefined();
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
