import { describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../commands/define-command.js";
import { createModeCommand, type ModeCommandDeps } from "../commands.js";
import { defineMode } from "../define-mode.js";

const plan = defineMode({ id: "plan", name: "Planning", description: "plan only" });
const review = defineMode({ id: "review", name: "Review", description: "review only" });

function buildDeps(overrides: Partial<ModeCommandDeps> = {}): {
  deps: ModeCommandDeps;
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
      ...overrides,
    },
    enter,
    exit,
    read,
  };
}

const CTX: CommandContext = {
  sessionId: "sess-1",
  // biome-ignore lint/suspicious/noExplicitAny: test fixture — fields unused
  sessionStore: {} as any,
  // biome-ignore lint/suspicious/noExplicitAny: test fixture — fields unused
  schedules: {} as any,
};

describe("createModeCommand", () => {
  it("returns a command named 'mode' with a description", () => {
    const { deps } = buildDeps();
    const cmd = createModeCommand(deps);
    expect(cmd.name).toBe("mode");
    expect(cmd.description).toContain("mode");
  });

  it("/mode with no argument reports when no mode is active", async () => {
    const { deps, exit } = buildDeps();
    const cmd = createModeCommand(deps);
    const result = await cmd.execute({ _raw: "" } as never, CTX);
    expect(exit).not.toHaveBeenCalled();
    expect(result.text).toBe("No mode is active.");
  });

  it("/mode with no argument exits the active mode", async () => {
    const { deps, exit } = buildDeps({ readActiveMode: () => plan });
    const cmd = createModeCommand(deps);
    const result = await cmd.execute({ _raw: "" } as never, CTX);
    expect(exit).toHaveBeenCalledWith("sess-1");
    expect(result.text).toContain("Exited mode: Planning");
  });

  it("/mode <id> enters the named mode", async () => {
    const { deps, enter } = buildDeps();
    const cmd = createModeCommand(deps);
    const result = await cmd.execute({ _raw: "plan" } as never, CTX);
    expect(enter).toHaveBeenCalledWith("sess-1", "plan");
    expect(result.text).toContain("Entered mode: Planning");
  });

  it("/mode <unknown> returns a listing of available modes without entering", async () => {
    const { deps, enter } = buildDeps();
    const cmd = createModeCommand(deps);
    const result = await cmd.execute({ _raw: "ghost" } as never, CTX);
    expect(enter).not.toHaveBeenCalled();
    expect(result.text).toContain('Unknown mode "ghost"');
    expect(result.text).toContain("/mode plan");
    expect(result.text).toContain("/mode review");
  });

  it("tolerates an undefined args object (no-arg invocation path)", async () => {
    const { deps } = buildDeps();
    const cmd = createModeCommand(deps);
    const result = await cmd.execute(undefined as never, CTX);
    expect(result.text).toBe("No mode is active.");
  });
});
