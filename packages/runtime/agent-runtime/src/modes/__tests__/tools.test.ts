import type { ToolExecuteContext } from "@crabbykit/agent-core";
import { describe, expect, it, vi } from "vitest";
import { defineMode } from "../define-mode.js";
import { createEnterModeTool, createExitModeTool, type ModeToolDeps } from "../tools.js";

const plan = defineMode({ id: "plan", name: "Planning", description: "plan only" });
const review = defineMode({ id: "review", name: "Review", description: "review only" });

function buildDeps(overrides: Partial<ModeToolDeps> = {}): {
  deps: ModeToolDeps;
  enter: ReturnType<typeof vi.fn>;
  exit: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
} {
  const enter = vi.fn((_sid: string, modeId: string) => {
    const m = [plan, review].find((x) => x.id === modeId);
    if (!m) throw new Error("unknown");
    return m;
  });
  const exit = vi.fn(() => null);
  const read = vi.fn(() => null);
  return {
    deps: {
      getModes: () => [plan, review],
      enterMode: enter,
      exitMode: exit,
      readActiveMode: read,
      getSessionId: () => "sess-1",
      ...overrides,
    },
    enter,
    exit,
    read,
  };
}

const TOOL_CTX = {} as ToolExecuteContext;

describe("createEnterModeTool", () => {
  it("returns a tool named enter_mode with a TypeBox id parameter", () => {
    const { deps } = buildDeps();
    const tool = createEnterModeTool(deps);
    expect(tool.name).toBe("enter_mode");
    expect(tool.description).toContain("Enter a named mode");
  });

  it("enters a known mode and returns confirmation", async () => {
    const { deps, enter } = buildDeps();
    const tool = createEnterModeTool(deps);
    const result = await tool.execute({ id: "plan" }, TOOL_CTX);
    expect(enter).toHaveBeenCalledWith("sess-1", "plan");
    expect(result.content[0]).toMatchObject({ type: "text" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Entered mode: Planning");
    expect(result.details).toMatchObject({ modeId: "plan", modeName: "Planning" });
  });

  it("returns an error for an unknown mode id and lists available modes", async () => {
    const { deps, enter } = buildDeps();
    const tool = createEnterModeTool(deps);
    const result = await tool.execute({ id: "ghost" }, TOOL_CTX);
    expect(enter).not.toHaveBeenCalled();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Unknown mode "ghost"');
    expect(text).toContain("- plan:");
    expect(text).toContain("- review:");
  });
});

describe("createExitModeTool", () => {
  it("returns a tool named exit_mode with empty parameters", () => {
    const { deps } = buildDeps();
    const tool = createExitModeTool(deps);
    expect(tool.name).toBe("exit_mode");
  });

  it("no-ops and reports when no mode is active", async () => {
    const { deps, exit } = buildDeps();
    const tool = createExitModeTool(deps);
    const result = await tool.execute({}, TOOL_CTX);
    expect(exit).not.toHaveBeenCalled();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toBe("No mode is active.");
    expect(result.details).toMatchObject({ exited: false });
  });

  it("exits the active mode and returns confirmation", async () => {
    const { deps, exit } = buildDeps({ readActiveMode: () => plan });
    const tool = createExitModeTool(deps);
    const result = await tool.execute({}, TOOL_CTX);
    expect(exit).toHaveBeenCalledWith("sess-1");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Exited mode: Planning");
    expect(result.details).toMatchObject({ modeId: "plan", exited: true });
  });
});
