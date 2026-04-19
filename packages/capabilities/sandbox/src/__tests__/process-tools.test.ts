import type { AgentContext, CapabilityStorage } from "@crabbykit/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import { sandboxCapability } from "../capability.js";
import { setProcessOwner, setSessionElevated } from "../session-state.js";
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
    rateLimit: { consume: async () => ({ allowed: true }) },
    notifyBundlePointerChanged: async () => {},
  };
}

function getToolWithProvider(name: string, provider: SandboxProvider, ctx: AgentContext) {
  const cap = sandboxCapability({ provider });
  const tools = cap.tools!(ctx);
  return tools.find((t) => t.name === name)!;
}

describe("process tool", () => {
  it("rejects when not elevated", async () => {
    const storage = createMapStorage();
    const ctx = mockContext("s1", storage);
    const tool = getToolWithProvider("process", mockProvider(), ctx);
    const result = await tool.execute({ action: "list" }, { toolCallId: "test" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("elevate");
  });

  describe("list action", () => {
    it("returns no active sessions when empty", async () => {
      const storage = createMapStorage();
      await setSessionElevated(storage, "s1", "reason");
      const ctx = mockContext("s1", storage);
      const tool = getToolWithProvider("process", mockProvider(), ctx);
      const result = await tool.execute({ action: "list" }, { toolCallId: "test" });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toBe("No active sessions.");
    });

    it("lists only owned sessions", async () => {
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
        {
          sessionId: "s-def",
          command: "npm start",
          running: true,
          exitCode: null,
          pid: 43,
          startedAt: Date.now() - 5_000,
          logFile: "/tmp/sandbox-logs/s-def.log",
          outputBytes: 512,
        },
      ]);

      const storage = createMapStorage();
      await setSessionElevated(storage, "s1", "reason");
      // s1 owns s-abc, someone else owns s-def
      await setProcessOwner(storage, "s-abc", "s1");
      await setProcessOwner(storage, "s-def", "s2");

      const ctx = mockContext("s1", storage);
      const tool = getToolWithProvider("process", provider, ctx);

      const result = await tool.execute({ action: "list" }, { toolCallId: "test" });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("s-abc");
      expect(text).not.toContain("s-def");
    });
  });

  describe("poll action", () => {
    it("calls sessionPoll for owned session", async () => {
      const provider = mockProvider();
      const storage = createMapStorage();
      await setSessionElevated(storage, "s1", "reason");
      await setProcessOwner(storage, "s-abc", "s1");

      const ctx = mockContext("s1", storage);
      const tool = getToolWithProvider("process", provider, ctx);

      const result = await tool.execute(
        { action: "poll", sessionId: "s-abc" },
        { toolCallId: "test" },
      );
      expect(provider.sessionPoll).toHaveBeenCalledWith("s-abc");

      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("some output");
    });

    it("rejects poll for non-owned session", async () => {
      const provider = mockProvider();
      const storage = createMapStorage();
      await setSessionElevated(storage, "s1", "reason");
      await setProcessOwner(storage, "s-abc", "s2"); // owned by s2

      const ctx = mockContext("s1", storage);
      const tool = getToolWithProvider("process", provider, ctx);

      const result = await tool.execute(
        { action: "poll", sessionId: "s-abc" },
        { toolCallId: "test" },
      );
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("not owned");
      expect(provider.sessionPoll).not.toHaveBeenCalled();
    });
  });

  describe("kill action", () => {
    it("calls sessionKill for owned session", async () => {
      const provider = mockProvider();
      const storage = createMapStorage();
      await setSessionElevated(storage, "s1", "reason");
      await setProcessOwner(storage, "s-abc", "s1");

      const ctx = mockContext("s1", storage);
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
    it("calls sessionWrite for owned session", async () => {
      const provider = mockProvider();
      const storage = createMapStorage();
      await setSessionElevated(storage, "s1", "reason");
      await setProcessOwner(storage, "s-abc", "s1");

      const ctx = mockContext("s1", storage);
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
    it("calls sessionLog for owned session", async () => {
      const provider = mockProvider();
      const storage = createMapStorage();
      await setSessionElevated(storage, "s1", "reason");
      await setProcessOwner(storage, "s-abc", "s1");

      const ctx = mockContext("s1", storage);
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
    it("calls sessionRemove and cleans up ownership", async () => {
      const provider = mockProvider();
      const storage = createMapStorage();
      await setSessionElevated(storage, "s1", "reason");
      await setProcessOwner(storage, "s-abc", "s1");

      const ctx = mockContext("s1", storage);
      const tool = getToolWithProvider("process", provider, ctx);

      const result = await tool.execute(
        { action: "remove", sessionId: "s-abc" },
        { toolCallId: "test" },
      );
      expect(provider.sessionRemove).toHaveBeenCalledWith("s-abc");

      // Ownership should be cleaned up
      expect(await storage.get("proc:s-abc")).toBeUndefined();

      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("removed");
    });
  });
});
