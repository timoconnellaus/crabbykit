import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

  it("source file imports nothing from capability packages", () => {
    const planFilePath = fileURLToPath(new URL("../built-in/plan.ts", import.meta.url));
    const source = readFileSync(planFilePath, "utf-8");
    // Must NOT import from any capability package — the only allowed
    // import is the local `define-mode.ts` for the type.
    const importLines = source.split("\n").filter((line) => /^\s*import\b/.test(line));
    for (const line of importLines) {
      expect(line).not.toMatch(/@crabbykit\/(?!agent-runtime)/);
      expect(line).not.toMatch(/file-tools|sandbox|vibe-coder|browserbase|tavily/);
    }
  });

  it("JSDoc warns about CLAW-only tool names", () => {
    const planFilePath = fileURLToPath(new URL("../built-in/plan.ts", import.meta.url));
    const source = readFileSync(planFilePath, "utf-8");
    expect(source).toMatch(/CLAW ecosystem tool names/i);
  });
});
