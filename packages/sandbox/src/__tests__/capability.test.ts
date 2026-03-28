import type { AgentContext } from "@claw-for-cloudflare/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import { sandboxCapability } from "../capability.js";
import type { SandboxProvider } from "../types.js";

function mockProvider(): SandboxProvider {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue({ ready: true }),
    exec: vi.fn().mockResolvedValue({ stdout: "hello", stderr: "", exitCode: 0 }),
    processStart: vi.fn().mockResolvedValue({ pid: 123 }),
    processStop: vi.fn().mockResolvedValue(undefined),
    processList: vi.fn().mockResolvedValue([]),
  };
}

function mockContext(): AgentContext {
  return {
    sessionId: "test-session",
    stepNumber: 0,
    emitCost: () => {},
    broadcast: vi.fn(),
    broadcastToAll: vi.fn(),
    schedules: {
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(null),
      setTimer: vi.fn().mockResolvedValue(undefined),
      cancelTimer: vi.fn().mockResolvedValue(undefined),
    },
    storage: {
      get: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(false),
      list: vi.fn().mockResolvedValue(new Map()),
    },
  };
}

describe("sandboxCapability", () => {
  it("has correct id and name", () => {
    const cap = sandboxCapability({ provider: mockProvider() });
    expect(cap.id).toBe("sandbox");
    expect(cap.name).toBe("Sandbox");
  });

  it("provides elevate, de_elevate, and bash tools", () => {
    const cap = sandboxCapability({ provider: mockProvider() });
    const tools = cap.tools!(mockContext());

    const names = tools.map((t) => t.name);
    expect(names).toContain("elevate");
    expect(names).toContain("de_elevate");
    expect(names).toContain("bash");
  });

  it("provides process tools when provider supports them", () => {
    const cap = sandboxCapability({ provider: mockProvider() });
    const tools = cap.tools!(mockContext());

    const names = tools.map((t) => t.name);
    expect(names).toContain("start_process");
    expect(names).toContain("stop_process");
    expect(names).toContain("get_process_status");
    expect(names).toContain("save_file_credential");
    expect(names).toContain("list_file_credentials");
    expect(names).toContain("delete_file_credential");
    expect(tools).toHaveLength(9);
  });

  it("omits process tools when provider does not support them", () => {
    const provider = mockProvider();
    // biome-ignore lint/performance/noDelete: test needs to remove optional methods
    delete (provider as unknown as Record<string, unknown>).processStart;
    // biome-ignore lint/performance/noDelete: test needs to remove optional methods
    delete (provider as unknown as Record<string, unknown>).processStop;
    // biome-ignore lint/performance/noDelete: test needs to remove optional methods
    delete (provider as unknown as Record<string, unknown>).processList;

    const cap = sandboxCapability({ provider });
    const tools = cap.tools!(mockContext());

    const names = tools.map((t) => t.name);
    expect(names).not.toContain("start_process");
    expect(names).not.toContain("stop_process");
    expect(names).not.toContain("get_process_status");
    // 3 core tools + 3 credential tools = 6
    expect(tools).toHaveLength(6);
  });

  it("provides prompt sections", () => {
    const cap = sandboxCapability({ provider: mockProvider() });
    const sections = cap.promptSections!(mockContext());
    expect(sections).toHaveLength(1);
    expect(sections[0]).toContain("elevate");
  });

  it("has beforeInference hook", () => {
    const cap = sandboxCapability({ provider: mockProvider() });
    expect(cap.hooks?.beforeInference).toBeInstanceOf(Function);
  });

  it("has schedules function for timer re-registration", () => {
    const cap = sandboxCapability({ provider: mockProvider() });
    expect(cap.schedules).toBeInstanceOf(Function);
    const schedules = cap.schedules!(mockContext());
    expect(schedules).toHaveLength(1);
    expect(schedules[0].id).toBe("sandbox:de-elevate");
  });

  describe("elevate tool", () => {
    it("calls provider.start and sets state", async () => {
      const provider = mockProvider();
      const ctx = mockContext();
      const cap = sandboxCapability({ provider });
      const tools = cap.tools!(ctx);
      const elevate = tools.find((t) => t.name === "elevate")!;

      const result = await elevate.execute({ reason: "need shell" }, { toolCallId: "tc1" });

      expect(provider.start).toHaveBeenCalled();
      expect(ctx.storage!.put).toHaveBeenCalledWith("elevated", true);
      expect(ctx.schedules.setTimer).toHaveBeenCalled();
      expect(ctx.broadcast).toHaveBeenCalledWith("sandbox_elevation", {
        elevated: true,
        reason: "need shell",
      });
      expect(result.content[0]).toHaveProperty("text");
    });
  });

  describe("bash tool", () => {
    it("rejects when not elevated", async () => {
      const ctx = mockContext();
      const cap = sandboxCapability({ provider: mockProvider() });
      const tools = cap.tools!(ctx);
      const bash = tools.find((t) => t.name === "bash")!;

      const result = await bash.execute({ command: "ls" }, { toolCallId: "tc1" });

      expect(result.content[0]).toHaveProperty("text");
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("elevate");
    });

    it("executes when elevated", async () => {
      const provider = mockProvider();
      const ctx = mockContext();
      (ctx.storage!.get as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const cap = sandboxCapability({ provider });
      const tools = cap.tools!(ctx);
      const bash = tools.find((t) => t.name === "bash")!;

      const result = await bash.execute({ command: "echo hello" }, { toolCallId: "tc1" });

      expect(provider.exec).toHaveBeenCalledWith("echo hello", {
        timeout: 60_000,
        cwd: "/mnt/r2",
      });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toBe("hello");
    });
  });

  describe("de_elevate tool", () => {
    it("clears state and cancels timer", async () => {
      const provider = mockProvider();
      const ctx = mockContext();
      (ctx.storage!.get as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const cap = sandboxCapability({ provider });
      const tools = cap.tools!(ctx);
      const deElevate = tools.find((t) => t.name === "de_elevate")!;

      const result = await deElevate.execute({}, { toolCallId: "tc1" });

      expect(ctx.storage!.put).toHaveBeenCalledWith("elevated", false);
      expect(ctx.schedules.cancelTimer).toHaveBeenCalledWith("sandbox:de-elevate");
      expect(ctx.broadcast).toHaveBeenCalledWith("sandbox_elevation", {
        elevated: false,
      });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("deactivated");
    });
  });
});
