import { describe, expect, it } from "vitest";
import { planMode } from "../built-in/plan.js";

describe("planMode built-in", () => {
  it("has the documented identity fields", () => {
    expect(planMode.id).toBe("plan");
    expect(planMode.name).toBe("Planning");
    expect(planMode.description).toBeTruthy();
  });

  it("denies the documented CLAW ecosystem write/exec tool names", () => {
    const deny = planMode.tools?.deny ?? [];
    for (const expected of [
      "file_write",
      "file_edit",
      "file_delete",
      "file_move",
      "file_copy",
      "exec",
      "process",
      "show_preview",
      "hide_preview",
      "browser_click",
      "browser_type",
      "browser_navigate",
    ]) {
      expect(deny).toContain(expected);
    }
  });

  it("contains a planning promptAppend instruction", () => {
    expect(planMode.promptAppend).toBeTypeOf("string");
    expect(planMode.promptAppend as string).toContain("plan");
  });
});
