import type { AgentContext, CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import { sandboxCapability } from "../capability.js";
import type { SandboxProvider } from "../types.js";

/** Map-backed storage for realistic read/write behavior. */
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

function mockProvider(): SandboxProvider {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue({ ready: true }),
    exec: vi.fn().mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 }),
    sessionStart: vi
      .fn()
      .mockResolvedValue({ sessionId: "bg-1", pid: 42, logFile: "/tmp/bg-1.log" }),
    sessionList: vi.fn().mockResolvedValue([]),
    sessionPoll: vi.fn().mockResolvedValue({
      sessionId: "bg-1",
      running: true,
      exitCode: null,
      pending: "output",
      tail: "output",
      logFile: "/tmp/bg-1.log",
      retryAfterMs: 5000,
      outputBytes: 6,
      truncated: false,
    }),
    sessionKill: vi.fn().mockResolvedValue(undefined),
    sessionRemove: vi.fn().mockResolvedValue(undefined),
    sessionWrite: vi.fn().mockResolvedValue(undefined),
    sessionLog: vi.fn().mockResolvedValue("log content"),
    processList: vi.fn().mockResolvedValue([]),
    processStop: vi.fn().mockResolvedValue(undefined),
  };
}

function mockContext(sessionId: string, storage: CapabilityStorage): AgentContext {
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
    storage,
  };
}

function getTools(provider: SandboxProvider, ctx: AgentContext) {
  const cap = sandboxCapability({ provider });
  const tools = cap.tools!(ctx);
  return {
    elevate: tools.find((t) => t.name === "elevate")!,
    deElevate: tools.find((t) => t.name === "de_elevate")!,
    exec: tools.find((t) => t.name === "exec")!,
    process: tools.find((t) => t.name === "process")!,
  };
}

describe("multi-session elevation independence", () => {
  it("session A elevates — provider.start() called", async () => {
    const storage = createMapStorage();
    const provider = mockProvider();
    const ctxA = mockContext("session-a", storage);
    const toolsA = getTools(provider, ctxA);

    const result = await toolsA.elevate.execute({ reason: "need shell" }, { toolCallId: "tc1" });
    const text = (result.content[0] as { text: string }).text;

    expect(text).toContain("activated");
    expect(provider.start).toHaveBeenCalledTimes(1);
    expect(ctxA.broadcast).toHaveBeenCalledWith("sandbox_elevation", {
      elevated: true,
      reason: "need shell",
    });
  });

  it("session B elevates when session A already elevated — provider.start() NOT called again", async () => {
    const storage = createMapStorage();
    const provider = mockProvider();
    const ctxA = mockContext("session-a", storage);
    const ctxB = mockContext("session-b", storage);
    const toolsA = getTools(provider, ctxA);
    const toolsB = getTools(provider, ctxB);

    await toolsA.elevate.execute({ reason: "a needs shell" }, { toolCallId: "tc1" });
    (provider.start as ReturnType<typeof vi.fn>).mockClear();

    const result = await toolsB.elevate.execute({ reason: "b needs shell" }, { toolCallId: "tc2" });
    const text = (result.content[0] as { text: string }).text;

    expect(text).toContain("activated");
    expect(provider.start).not.toHaveBeenCalled();
    expect(ctxB.broadcast).toHaveBeenCalledWith("sandbox_elevation", {
      elevated: true,
      reason: "b needs shell",
    });
  });

  it("session A de-elevates — provider.stop() NOT called (session B still elevated)", async () => {
    const storage = createMapStorage();
    const provider = mockProvider();
    const ctxA = mockContext("session-a", storage);
    const ctxB = mockContext("session-b", storage);
    const toolsA = getTools(provider, ctxA);
    const toolsB = getTools(provider, ctxB);

    await toolsA.elevate.execute({ reason: "a" }, { toolCallId: "tc1" });
    await toolsB.elevate.execute({ reason: "b" }, { toolCallId: "tc2" });

    const result = await toolsA.deElevate.execute({}, { toolCallId: "tc3" });
    const text = (result.content[0] as { text: string }).text;

    expect(text).toContain("deactivated");
    expect(provider.stop).not.toHaveBeenCalled();
    // Session A broadcast shows de-elevated
    expect(ctxA.broadcast).toHaveBeenCalledWith("sandbox_elevation", { elevated: false });
  });

  it("session B de-elevates (last one) — provider.stop() called", async () => {
    const storage = createMapStorage();
    const provider = mockProvider();
    const ctxA = mockContext("session-a", storage);
    const ctxB = mockContext("session-b", storage);
    const toolsA = getTools(provider, ctxA);
    const toolsB = getTools(provider, ctxB);

    await toolsA.elevate.execute({ reason: "a" }, { toolCallId: "tc1" });
    await toolsB.elevate.execute({ reason: "b" }, { toolCallId: "tc2" });
    await toolsA.deElevate.execute({}, { toolCallId: "tc3" });

    const result = await toolsB.deElevate.execute({}, { toolCallId: "tc4" });
    const text = (result.content[0] as { text: string }).text;

    expect(text).toContain("deactivated");
    expect(provider.stop).toHaveBeenCalled();
  });

  it("session A already elevated — elevating again returns already elevated", async () => {
    const storage = createMapStorage();
    const provider = mockProvider();
    const ctxA = mockContext("session-a", storage);
    const toolsA = getTools(provider, ctxA);

    await toolsA.elevate.execute({ reason: "first" }, { toolCallId: "tc1" });
    const result = await toolsA.elevate.execute({ reason: "second" }, { toolCallId: "tc2" });
    const text = (result.content[0] as { text: string }).text;

    expect(text).toContain("Already elevated");
  });

  it("session B de-elevating when not elevated returns not elevated", async () => {
    const storage = createMapStorage();
    const provider = mockProvider();
    const ctxB = mockContext("session-b", storage);
    const toolsB = getTools(provider, ctxB);

    const result = await toolsB.deElevate.execute({}, { toolCallId: "tc1" });
    const text = (result.content[0] as { text: string }).text;

    expect(text).toContain("Not currently elevated");
  });
});

describe("exec gating per session", () => {
  it("session A elevated, session B not — A can exec, B cannot", async () => {
    const storage = createMapStorage();
    const provider = mockProvider();
    const ctxA = mockContext("session-a", storage);
    const ctxB = mockContext("session-b", storage);
    const toolsA = getTools(provider, ctxA);
    const toolsB = getTools(provider, ctxB);

    await toolsA.elevate.execute({ reason: "a" }, { toolCallId: "tc1" });

    const resultA = await toolsA.exec.execute({ command: "echo hi" }, { toolCallId: "tc2" });
    expect((resultA.content[0] as { text: string }).text).toBe("ok");

    const resultB = await toolsB.exec.execute({ command: "echo hi" }, { toolCallId: "tc3" });
    expect((resultB.content[0] as { text: string }).text).toContain("elevate");
  });
});

describe("process isolation", () => {
  it("session A's processes are not visible to session B", async () => {
    const storage = createMapStorage();
    const provider = mockProvider();
    let bgCounter = 0;
    (provider.sessionStart as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      bgCounter++;
      return {
        sessionId: `bg-${bgCounter}`,
        pid: 100 + bgCounter,
        logFile: `/tmp/bg-${bgCounter}.log`,
      };
    });
    (provider.sessionList as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        sessionId: "bg-1",
        command: "npm test",
        running: true,
        exitCode: null,
        pid: 101,
        startedAt: Date.now(),
        logFile: "/tmp/bg-1.log",
        outputBytes: 0,
      },
      {
        sessionId: "bg-2",
        command: "npm start",
        running: true,
        exitCode: null,
        pid: 102,
        startedAt: Date.now(),
        logFile: "/tmp/bg-2.log",
        outputBytes: 0,
      },
    ]);

    const ctxA = mockContext("session-a", storage);
    const ctxB = mockContext("session-b", storage);
    const toolsA = getTools(provider, ctxA);
    const toolsB = getTools(provider, ctxB);

    // Both elevate
    await toolsA.elevate.execute({ reason: "a" }, { toolCallId: "tc1" });
    await toolsB.elevate.execute({ reason: "b" }, { toolCallId: "tc2" });

    // Session A starts a background process
    await toolsA.exec.execute({ command: "npm test", background: true }, { toolCallId: "tc3" });
    // Session B starts a background process
    await toolsB.exec.execute({ command: "npm start", background: true }, { toolCallId: "tc4" });

    // Session A lists — should only see bg-1
    const listA = await toolsA.process.execute({ action: "list" }, { toolCallId: "tc5" });
    const textA = (listA.content[0] as { text: string }).text;
    expect(textA).toContain("bg-1");
    expect(textA).not.toContain("bg-2");

    // Session B lists — should only see bg-2
    const listB = await toolsB.process.execute({ action: "list" }, { toolCallId: "tc6" });
    const textB = (listB.content[0] as { text: string }).text;
    expect(textB).toContain("bg-2");
    expect(textB).not.toContain("bg-1");
  });

  it("session A cannot kill session B's process", async () => {
    const storage = createMapStorage();
    const provider = mockProvider();
    let bgCounter = 0;
    (provider.sessionStart as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      bgCounter++;
      return {
        sessionId: `bg-${bgCounter}`,
        pid: 100 + bgCounter,
        logFile: `/tmp/bg-${bgCounter}.log`,
      };
    });

    const ctxA = mockContext("session-a", storage);
    const ctxB = mockContext("session-b", storage);
    const toolsA = getTools(provider, ctxA);
    const toolsB = getTools(provider, ctxB);

    await toolsA.elevate.execute({ reason: "a" }, { toolCallId: "tc1" });
    await toolsB.elevate.execute({ reason: "b" }, { toolCallId: "tc2" });

    // Session A starts bg-1
    await toolsA.exec.execute({ command: "npm test", background: true }, { toolCallId: "tc3" });
    // Session B starts bg-2
    await toolsB.exec.execute({ command: "npm start", background: true }, { toolCallId: "tc4" });

    // Session A tries to kill bg-2 (owned by B)
    const killResult = await toolsA.process.execute(
      { action: "kill", sessionId: "bg-2" },
      { toolCallId: "tc5" },
    );
    const text = (killResult.content[0] as { text: string }).text;
    expect(text).toContain("not owned");
    expect(provider.sessionKill).not.toHaveBeenCalled();

    // Session A kills its own bg-1 — succeeds
    const killOwnResult = await toolsA.process.execute(
      { action: "kill", sessionId: "bg-1" },
      { toolCallId: "tc6" },
    );
    const ownText = (killOwnResult.content[0] as { text: string }).text;
    expect(ownText).toContain("kill requested");
    expect(provider.sessionKill).toHaveBeenCalledWith("bg-1");
  });

  it("remove also cleans up ownership record", async () => {
    const storage = createMapStorage();
    const provider = mockProvider();
    (provider.sessionStart as ReturnType<typeof vi.fn>).mockResolvedValue({
      sessionId: "bg-1",
      pid: 101,
      logFile: "/tmp/bg-1.log",
    });

    const ctxA = mockContext("session-a", storage);
    const toolsA = getTools(provider, ctxA);

    await toolsA.elevate.execute({ reason: "a" }, { toolCallId: "tc1" });
    await toolsA.exec.execute({ command: "npm test", background: true }, { toolCallId: "tc2" });

    // Remove the process
    await toolsA.process.execute({ action: "remove", sessionId: "bg-1" }, { toolCallId: "tc3" });

    // Now listing should show empty (no ownership records for this session)
    (provider.sessionList as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const listResult = await toolsA.process.execute({ action: "list" }, { toolCallId: "tc4" });
    const text = (listResult.content[0] as { text: string }).text;
    expect(text).toBe("No active sessions.");
  });
});

describe("beforeInference per-session scoping", () => {
  it("injects guidance only for the elevated session", async () => {
    const storage = createMapStorage();
    const provider = mockProvider();
    const cap = sandboxCapability({ provider });

    // Manually set session-a as elevated
    await storage.put("session:session-a:elevated", true);
    await storage.put("session:session-a:reason", "need shell");

    const messages = [{ role: "user" as const, content: "hello", timestamp: 1 }];

    // Session A should get guidance
    const resultA = await cap.hooks!.beforeInference!(messages, {
      agentId: "test-agent",
      sessionId: "session-a",
      sessionStore: {} as never,
      storage,
      capabilityIds: [],
    });
    expect(resultA).toHaveLength(2);
    expect((resultA![0] as { content: string }).content).toContain("Sandbox Status: ACTIVE");
    expect((resultA![0] as { content: string }).content).toContain("need shell");

    // Session B should NOT get guidance
    const resultB = await cap.hooks!.beforeInference!(messages, {
      agentId: "test-agent",
      sessionId: "session-b",
      sessionStore: {} as never,
      storage,
      capabilityIds: [],
    });
    expect(resultB).toHaveLength(1);
  });
});
