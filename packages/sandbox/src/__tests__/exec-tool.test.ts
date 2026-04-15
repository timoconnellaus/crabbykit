import type { AgentContext, CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import { setSessionElevated } from "../session-state.js";
import { createExecTool } from "../tools/exec.js";
import type { ExecStreamEvent, SandboxConfig, SandboxProvider } from "../types.js";

function createMapStorage(): CapabilityStorage {
  const store = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return store.get(key) as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<boolean> {
      return store.delete(key);
    },
    async list<T>(prefix?: string): Promise<Map<string, T>> {
      const result = new Map<string, T>();
      for (const [k, v] of store) {
        if (!prefix || k.startsWith(prefix)) {
          result.set(k, v as T);
        }
      }
      return result;
    },
  };
}

const DEFAULT_CONFIG: Required<SandboxConfig> = {
  idleTimeout: 180,
  activeTimeout: 900,
  defaultCwd: "/workspace",
  defaultExecTimeout: 60_000,
};

function mockProvider(overrides?: Partial<SandboxProvider>): SandboxProvider {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue({ ready: true }),
    exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
    ...overrides,
  };
}

function mockContext(sessionId = "test-session", storage?: CapabilityStorage): AgentContext {
  return {
    agentId: "test-agent",
    sessionId,
    stepNumber: 0,
    emitCost: () => {},
    broadcast: vi.fn(),
    broadcastToAll: vi.fn(),
    broadcastState: vi.fn(),
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
    storage: storage ?? createMapStorage(),
    rateLimit: { consume: async () => ({ allowed: true }) },
    notifyBundlePointerChanged: async () => {},
  };
}

describe("exec tool — sessionExecStream path", () => {
  it("streams stdout and stderr via sessionExecStream when onUpdate is present", async () => {
    const events: (ExecStreamEvent & { sessionId?: string; logFile?: string })[] = [
      { type: "stdout" as const, data: "", sessionId: "ses-1", logFile: "/tmp/ses-1.log" },
      { type: "stdout" as const, data: "line1\n" },
      { type: "stderr" as const, data: "warn\n" },
      { type: "exit" as const, code: 0 },
    ];

    async function* fakeSessionExecStream() {
      for (const event of events) yield event;
    }

    const provider = mockProvider({
      sessionExecStream: vi.fn().mockReturnValue(fakeSessionExecStream()),
    });

    const storage = createMapStorage();
    await setSessionElevated(storage, "test-session", "reason");
    const ctx = mockContext("test-session", storage);

    const tool = createExecTool(provider, DEFAULT_CONFIG, ctx);
    const onUpdate = vi.fn();
    const result = await tool.execute({ command: "echo line1" }, { toolCallId: "tc1", onUpdate });

    // onUpdate called for stdout and stderr chunks
    expect(onUpdate).toHaveBeenCalledTimes(2);

    // First call: stdout only
    const firstCall = onUpdate.mock.calls[0][0];
    expect(firstCall.content[0].text).toBe("line1\n");
    expect(firstCall.details.sessionId).toBe("ses-1");
    expect(firstCall.details.logFile).toBe("/tmp/ses-1.log");

    // Second call: stdout + stderr
    const secondCall = onUpdate.mock.calls[1][0];
    expect(secondCall.content[0].text).toContain("[stderr]");
    expect(secondCall.content[0].text).toContain("warn\n");

    // Final result includes sessionId and logFile
    expect(result.details).toMatchObject({
      exitCode: 0,
      stdout: "line1\n",
      stderr: "warn\n",
      sessionId: "ses-1",
      logFile: "/tmp/ses-1.log",
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("line1");
    expect(text).toContain("[stderr]");
    expect(text).toContain("[output logged to /tmp/ses-1.log]");
  });
});

describe("exec tool — execStream path", () => {
  it("streams via execStream when sessionExecStream is absent", async () => {
    const events: ExecStreamEvent[] = [
      { type: "stdout", data: "out1" },
      { type: "stderr", data: "err1" },
      { type: "exit", code: 2 },
    ];

    async function* fakeExecStream() {
      for (const event of events) yield event;
    }

    const provider = mockProvider({
      execStream: vi.fn().mockReturnValue(fakeExecStream()),
    });

    const storage = createMapStorage();
    await setSessionElevated(storage, "test-session", "reason");
    const ctx = mockContext("test-session", storage);

    const tool = createExecTool(provider, DEFAULT_CONFIG, ctx);
    const onUpdate = vi.fn();
    const result = await tool.execute({ command: "failing-cmd" }, { toolCallId: "tc1", onUpdate });

    expect(onUpdate).toHaveBeenCalledTimes(2);

    // Stdout update
    const firstUpdate = onUpdate.mock.calls[0][0];
    expect(firstUpdate.content[0].text).toBe("out1");
    expect(firstUpdate.details.exitCode).toBeNull();

    // Stderr update
    const secondUpdate = onUpdate.mock.calls[1][0];
    expect(secondUpdate.content[0].text).toContain("[stderr]");
    expect(secondUpdate.content[0].text).toContain("err1");

    // Final result
    expect(result.details).toMatchObject({ exitCode: 2, stdout: "out1", stderr: "err1" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("[exit code: 2]");
  });

  it("falls back to provider.exec when no onUpdate is present", async () => {
    const provider = mockProvider({
      execStream: vi.fn(),
      exec: vi.fn().mockResolvedValue({ stdout: "plain", stderr: "", exitCode: 0 }),
    });

    const storage = createMapStorage();
    await setSessionElevated(storage, "test-session", "reason");
    const ctx = mockContext("test-session", storage);

    const tool = createExecTool(provider, DEFAULT_CONFIG, ctx);
    // No onUpdate — should not use execStream
    const result = await tool.execute({ command: "ls" }, { toolCallId: "tc1" });

    expect(provider.execStream).not.toHaveBeenCalled();
    expect(provider.exec).toHaveBeenCalled();
    expect((result.content[0] as { text: string }).text).toBe("plain");
  });
});

describe("exec tool — background mode", () => {
  it("returns not supported when provider has no sessionStart", async () => {
    const provider = mockProvider();
    const storage = createMapStorage();
    await setSessionElevated(storage, "test-session", "reason");
    const ctx = mockContext("test-session", storage);

    const tool = createExecTool(provider, DEFAULT_CONFIG, ctx);
    const result = await tool.execute(
      { command: "npm start", background: true },
      { toolCallId: "tc1" },
    );

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("not supported");
  });

  it("starts a background session and records process ownership", async () => {
    const provider = mockProvider({
      sessionStart: vi.fn().mockResolvedValue({
        sessionId: "bg-1",
        pid: 42,
        logFile: "/tmp/bg-1.log",
      }),
      sessionPoll: vi.fn().mockResolvedValue({
        pending: "Server started",
        tail: "Server started",
      }),
    });

    const storage = createMapStorage();
    await setSessionElevated(storage, "test-session", "reason");
    const ctx = mockContext("test-session", storage);

    const tool = createExecTool(provider, DEFAULT_CONFIG, ctx);
    const result = await tool.execute(
      { command: "npm start", background: true },
      { toolCallId: "tc1" },
    );

    // sessionStart called with correct args
    expect(provider.sessionStart).toHaveBeenCalledWith("npm start", { cwd: "/workspace" });

    // Process ownership recorded
    const owner = await storage.get<string>("proc:bg-1");
    expect(owner).toBe("test-session");

    // Initial poll output included
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("bg-1");
    expect(text).toContain("PID 42");
    expect(text).toContain("Server started");
    expect(text).toContain("logging to /tmp/bg-1.log");

    // Details include session info
    expect(result.details).toMatchObject({
      sessionId: "bg-1",
      pid: 42,
      logFile: "/tmp/bg-1.log",
      tail: "Server started",
    });

    // Timer reset with activeTimeout
    expect(ctx.schedules.setTimer).toHaveBeenCalledWith("sandbox:de-elevate", 900);

    // Broadcasts sandbox_timeout
    expect(ctx.broadcast).toHaveBeenCalledWith(
      "sandbox_timeout",
      expect.objectContaining({
        timeoutSeconds: 900,
      }),
    );
  });

  it("handles missing sessionPoll gracefully in background mode", async () => {
    const provider = mockProvider({
      sessionStart: vi.fn().mockResolvedValue({
        sessionId: "bg-2",
        pid: 99,
        logFile: "/tmp/bg-2.log",
      }),
      // No sessionPoll
    });

    const storage = createMapStorage();
    await setSessionElevated(storage, "test-session", "reason");
    const ctx = mockContext("test-session", storage);

    const tool = createExecTool(provider, DEFAULT_CONFIG, ctx);
    const result = await tool.execute(
      { command: "npm run dev", background: true },
      { toolCallId: "tc1" },
    );

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("bg-2");
    expect(text).toContain("PID 99");
    // No tail output since poll not available
    expect((result.details as { tail: string }).tail).toBe("");
  });
});

describe("exec tool — resetTimer logic", () => {
  it("uses activeTimeout when sessionList has running sessions", async () => {
    const provider = mockProvider({
      exec: vi.fn().mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 }),
      sessionList: vi.fn().mockResolvedValue([
        {
          sessionId: "s1",
          running: true,
          command: "npm start",
          exitCode: null,
          pid: 1,
          startedAt: Date.now(),
          logFile: "/tmp/s1.log",
          outputBytes: 0,
        },
      ]),
    });

    const storage = createMapStorage();
    await setSessionElevated(storage, "test-session", "reason");
    const ctx = mockContext("test-session", storage);

    const tool = createExecTool(provider, DEFAULT_CONFIG, ctx);
    await tool.execute({ command: "echo ok" }, { toolCallId: "tc1" });

    // Should use activeTimeout (900) since there are running sessions
    expect(ctx.schedules.setTimer).toHaveBeenCalledWith("sandbox:de-elevate", 900);
    expect(ctx.broadcast).toHaveBeenCalledWith(
      "sandbox_timeout",
      expect.objectContaining({
        timeoutSeconds: 900,
      }),
    );
  });

  it("uses activeTimeout when processList has running processes", async () => {
    const provider = mockProvider({
      exec: vi.fn().mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 }),
      sessionList: vi.fn().mockResolvedValue([]), // no running sessions
      processList: vi
        .fn()
        .mockResolvedValue([{ name: "dev", running: true, command: "npm run dev", pid: 100 }]),
    });

    const storage = createMapStorage();
    await setSessionElevated(storage, "test-session", "reason");
    const ctx = mockContext("test-session", storage);

    const tool = createExecTool(provider, DEFAULT_CONFIG, ctx);
    await tool.execute({ command: "echo ok" }, { toolCallId: "tc1" });

    expect(ctx.schedules.setTimer).toHaveBeenCalledWith("sandbox:de-elevate", 900);
  });

  it("uses idleTimeout when no active sessions or processes", async () => {
    const provider = mockProvider({
      exec: vi.fn().mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 }),
      sessionList: vi.fn().mockResolvedValue([]),
      processList: vi.fn().mockResolvedValue([]),
    });

    const storage = createMapStorage();
    await setSessionElevated(storage, "test-session", "reason");
    const ctx = mockContext("test-session", storage);

    const tool = createExecTool(provider, DEFAULT_CONFIG, ctx);
    await tool.execute({ command: "echo ok" }, { toolCallId: "tc1" });

    expect(ctx.schedules.setTimer).toHaveBeenCalledWith("sandbox:de-elevate", 180);
  });

  it("broadcasts sandbox_timeout with expiry info", async () => {
    const provider = mockProvider({
      exec: vi.fn().mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 }),
    });

    const storage = createMapStorage();
    await setSessionElevated(storage, "test-session", "reason");
    const ctx = mockContext("test-session", storage);

    const tool = createExecTool(provider, DEFAULT_CONFIG, ctx);
    await tool.execute({ command: "echo ok" }, { toolCallId: "tc1" });

    expect(ctx.broadcast).toHaveBeenCalledWith(
      "sandbox_timeout",
      expect.objectContaining({
        timeoutSeconds: expect.any(Number),
        expiresAt: expect.any(Number),
      }),
    );
  });

  it("handles sessionList errors gracefully in resetTimer", async () => {
    const provider = mockProvider({
      exec: vi.fn().mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 }),
      sessionList: vi.fn().mockRejectedValue(new Error("connection refused")),
      processList: vi.fn().mockResolvedValue([]),
    });

    const storage = createMapStorage();
    await setSessionElevated(storage, "test-session", "reason");
    const ctx = mockContext("test-session", storage);

    const tool = createExecTool(provider, DEFAULT_CONFIG, ctx);
    // Should not throw — errors in sessionList/processList are best-effort
    await tool.execute({ command: "echo ok" }, { toolCallId: "tc1" });

    // Falls back to idleTimeout
    expect(ctx.schedules.setTimer).toHaveBeenCalledWith("sandbox:de-elevate", 180);
  });
});
