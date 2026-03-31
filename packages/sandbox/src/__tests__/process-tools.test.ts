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
    sessionList: vi.fn().mockResolvedValue([]),
    sessionPoll: vi.fn().mockResolvedValue({
      sessionId: "s-abc",
      running: true,
      exitCode: null,
      pending: "some output",
      tail: "some output",
      logFile: "/tmp/sandbox-logs/s-abc.log",
      retryAfterMs: 5000,
      outputBytes: 11,
      truncated: false,
    }),
    sessionKill: vi.fn().mockResolvedValue(undefined),
    sessionRemove: vi.fn().mockResolvedValue(undefined),
    sessionWrite: vi.fn().mockResolvedValue(undefined),
    sessionLog: vi.fn().mockResolvedValue("full log content"),
  };
}

function mockContext(elevated = false): AgentContext {
  return {
    sessionId: "s1",
    stepNumber: 0,
    emitCost: () => {},
    broadcast: vi.fn(),
    broadcastToAll: vi.fn(),
    requestFromClient: vi.fn().mockResolvedValue({}),
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

describe("process tool", () => {
  it("rejects when not elevated", async () => {
    const ctx = mockContext(false);
    const tool = getTool("process", ctx);
    const result = await tool.execute({ action: "list" }, { toolCallId: "test" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("elevate");
  });

  describe("list action", () => {
    it("returns no active sessions when empty", async () => {
      const ctx = mockContext(true);
      const tool = getTool("process", ctx);
      const result = await tool.execute({ action: "list" }, { toolCallId: "test" });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toBe("No active sessions.");
    });

    it("lists sessions with status", async () => {
      const provider = mockProvider();
      (provider.sessionList as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          sessionId: "s-abc",
          command: "npm test",
          running: true,
          exitCode: null,
          pid: 42,
          startedAt: Date.now() - 10_000,
          logFile: "/tmp/sandbox-logs/s-abc.log",
          outputBytes: 1024,
        },
      ]);
      const ctx = mockContext(true);
      const tool = getToolWithProvider("process", provider, ctx);

      const result = await tool.execute({ action: "list" }, { toolCallId: "test" });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("s-abc");
      expect(text).toContain("running");
      expect(text).toContain("npm test");
    });
  });

  describe("poll action", () => {
    it("calls sessionPoll and returns pending output", async () => {
      const provider = mockProvider();
      const ctx = mockContext(true);
      const tool = getToolWithProvider("process", provider, ctx);

      const result = await tool.execute(
        { action: "poll", sessionId: "s-abc" },
        { toolCallId: "test" },
      );
      expect(provider.sessionPoll).toHaveBeenCalledWith("s-abc");

      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("some output");
      expect(text).toContain("running");
      expect(text).toContain("retry in 5s");
    });
  });

  describe("kill action", () => {
    it("calls sessionKill", async () => {
      const provider = mockProvider();
      const ctx = mockContext(true);
      const tool = getToolWithProvider("process", provider, ctx);

      const result = await tool.execute(
        { action: "kill", sessionId: "s-abc" },
        { toolCallId: "test" },
      );
      expect(provider.sessionKill).toHaveBeenCalledWith("s-abc");

      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("kill requested");
    });
  });

  describe("write action", () => {
    it("calls sessionWrite", async () => {
      const provider = mockProvider();
      const ctx = mockContext(true);
      const tool = getToolWithProvider("process", provider, ctx);

      const result = await tool.execute(
        { action: "write", sessionId: "s-abc", input: "hello\n" },
        { toolCallId: "test" },
      );
      expect(provider.sessionWrite).toHaveBeenCalledWith("s-abc", "hello\n");

      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("Wrote 6 bytes");
    });
  });

  describe("log action", () => {
    it("calls sessionLog and returns content", async () => {
      const provider = mockProvider();
      const ctx = mockContext(true);
      const tool = getToolWithProvider("process", provider, ctx);

      const result = await tool.execute(
        { action: "log", sessionId: "s-abc" },
        { toolCallId: "test" },
      );
      expect(provider.sessionLog).toHaveBeenCalledWith("s-abc", undefined);

      const text = (result.content[0] as { text: string }).text;
      expect(text).toBe("full log content");
    });
  });

  describe("remove action", () => {
    it("calls sessionRemove", async () => {
      const provider = mockProvider();
      const ctx = mockContext(true);
      const tool = getToolWithProvider("process", provider, ctx);

      const result = await tool.execute(
        { action: "remove", sessionId: "s-abc" },
        { toolCallId: "test" },
      );
      expect(provider.sessionRemove).toHaveBeenCalledWith("s-abc");

      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("removed");
    });
  });
});
