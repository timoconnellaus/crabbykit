import type { AgentContext } from "@claw-for-cloudflare/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import { sandboxCapability } from "../capability.js";
import type { SandboxProvider } from "../types.js";

function mockProvider(): SandboxProvider {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue({ ready: true }),
    exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
    processStart: vi.fn().mockResolvedValue({ pid: 42 }),
    processStop: vi.fn().mockResolvedValue(undefined),
    processList: vi.fn().mockResolvedValue([]),
  };
}

function mockContext(elevated = false): AgentContext {
  return {
    sessionId: "s1",
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
      get: vi.fn().mockResolvedValue(elevated ? true : undefined),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(false),
      list: vi.fn().mockResolvedValue(new Map()),
    },
  };
}

function getTool(name: string, ctx: AgentContext) {
  const cap = sandboxCapability({ provider: mockProvider() });
  const tools = cap.tools!(ctx);
  return tools.find((t) => t.name === name)!;
}

function getToolWithProvider(name: string, provider: SandboxProvider, ctx: AgentContext) {
  const cap = sandboxCapability({ provider });
  const tools = cap.tools!(ctx);
  return tools.find((t) => t.name === name)!;
}

describe("start_process tool", () => {
  it("rejects when not elevated", async () => {
    const ctx = mockContext(false);
    const tool = getTool("start_process", ctx);
    const result = await tool.execute(
      { name: "dev", command: "npm start" },
      { toolCallId: "test" },
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("elevate");
  });

  it("calls provider.processStart when elevated", async () => {
    const provider = mockProvider();
    const ctx = mockContext(true);
    const tool = getToolWithProvider("start_process", provider, ctx);

    const result = await tool.execute(
      { name: "dev", command: "npm start" },
      { toolCallId: "test" },
    );
    expect(provider.processStart).toHaveBeenCalledWith("dev", "npm start", "/mnt/r2");

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("dev");
    expect(text).toContain("started");
  });

  it("resets timer with activeTimeout", async () => {
    const provider = mockProvider();
    const ctx = mockContext(true);
    const tool = getToolWithProvider("start_process", provider, ctx);

    await tool.execute({ name: "dev", command: "npm start" }, { toolCallId: "test" });

    expect(ctx.schedules.cancelTimer).toHaveBeenCalled();
    expect(ctx.schedules.setTimer).toHaveBeenCalled();
  });

  it("broadcasts sandbox_timeout", async () => {
    const ctx = mockContext(true);
    const tool = getTool("start_process", ctx);
    await tool.execute({ name: "dev", command: "npm start" }, { toolCallId: "test" });

    expect(ctx.broadcast).toHaveBeenCalledWith(
      "sandbox_timeout",
      expect.objectContaining({ timeoutSeconds: 900 }),
    );
  });
});

describe("stop_process tool", () => {
  it("rejects when not elevated", async () => {
    const ctx = mockContext(false);
    const tool = getTool("stop_process", ctx);
    const result = await tool.execute({ name: "dev" }, { toolCallId: "test" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("elevate");
  });

  it("calls provider.processStop when elevated", async () => {
    const provider = mockProvider();
    const ctx = mockContext(true);
    const tool = getToolWithProvider("stop_process", provider, ctx);

    const result = await tool.execute({ name: "dev" }, { toolCallId: "test" });
    expect(provider.processStop).toHaveBeenCalledWith("dev");

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("stopped");
  });
});

describe("get_process_status tool", () => {
  it("rejects when not elevated", async () => {
    const ctx = mockContext(false);
    const tool = getTool("get_process_status", ctx);
    const result = await tool.execute({}, { toolCallId: "test" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("elevate");
  });

  it("returns 'No managed processes' when empty", async () => {
    const ctx = mockContext(true);
    const tool = getTool("get_process_status", ctx);
    const result = await tool.execute({}, { toolCallId: "test" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toBe("No managed processes.");
  });

  it("formats running and stopped processes", async () => {
    const provider = mockProvider();
    (provider.processList as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: "server", command: "node app.js", pid: 100, running: true },
      { name: "build", command: "tsc -w", pid: 101, running: false, exitCode: 0 },
    ]);
    const ctx = mockContext(true);
    const tool = getToolWithProvider("get_process_status", provider, ctx);

    const result = await tool.execute({}, { toolCallId: "test" });
    const text = (result.content[0] as { text: string }).text;

    expect(text).toContain("server: running");
    expect(text).toContain("node app.js");
    expect(text).toContain("PID 100");
    expect(text).toContain("build: stopped (exit 0)");
  });
});
