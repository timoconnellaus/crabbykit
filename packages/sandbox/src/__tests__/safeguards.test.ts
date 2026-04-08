import type { AgentContext, CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import { sandboxCapability } from "../capability.js";
import { setSessionElevated } from "../session-state.js";
import { clearTeardownPromise, getTeardownPromise, setTeardownPromise } from "../teardown.js";
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

function mockProvider(overrides?: Partial<SandboxProvider>): SandboxProvider {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue({ ready: true }),
    exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
    processStart: vi.fn().mockResolvedValue({ pid: 1 }),
    processStop: vi.fn().mockResolvedValue(undefined),
    processList: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function mockContext(storage?: CapabilityStorage): AgentContext {
  return {
    agentId: "test-agent",
    sessionId: "s1",
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
  };
}

async function mockElevatedContext(): Promise<AgentContext> {
  const storage = createMapStorage();
  await setSessionElevated(storage, "s1", "reason");
  return mockContext(storage);
}

describe("Teardown serialization", () => {
  it("getTeardownPromise returns null initially", () => {
    clearTeardownPromise();
    expect(getTeardownPromise()).toBeNull();
  });

  it("setTeardownPromise stores the promise", () => {
    const p = Promise.resolve();
    setTeardownPromise(p);
    expect(getTeardownPromise()).toBe(p);
    clearTeardownPromise();
  });

  it("auto-clears when promise resolves", async () => {
    let resolve: () => void;
    const p = new Promise<void>((r) => {
      resolve = r;
    });
    setTeardownPromise(p);
    expect(getTeardownPromise()).toBe(p);
    resolve!();
    await p;
    // Wait a tick for finally() to run
    await new Promise((r) => setTimeout(r, 0));
    expect(getTeardownPromise()).toBeNull();
  });

  it("elevate waits for pending teardown", async () => {
    const provider = mockProvider();
    const ctx = mockContext();

    let resolveTeardown: () => void;
    const teardown = new Promise<void>((r) => {
      resolveTeardown = r;
    });
    setTeardownPromise(teardown);

    const cap = sandboxCapability({ provider });
    const elevate = cap.tools!(ctx).find((t) => t.name === "elevate")!;

    // Start elevate (it should wait for teardown)
    let elevateFinished = false;
    const elevatePromise = elevate.execute({ reason: "test" }, { toolCallId: "tc1" }).then(() => {
      elevateFinished = true;
    });

    // provider.start should not be called yet (waiting for teardown)
    await new Promise((r) => setTimeout(r, 10));
    expect(provider.start).not.toHaveBeenCalled();

    // Resolve teardown
    resolveTeardown!();
    await elevatePromise;
    expect(elevateFinished).toBe(true);
    expect(provider.start).toHaveBeenCalled();
    clearTeardownPromise();
  });
});

describe("Health check in elevate", () => {
  it("returns error when container is not ready", async () => {
    const provider = mockProvider({
      health: vi.fn().mockResolvedValue({ ready: false }),
    });
    const ctx = mockContext();

    const cap = sandboxCapability({ provider });
    const elevate = cap.tools!(ctx).find((t) => t.name === "elevate")!;

    const result = await elevate.execute({ reason: "test" }, { toolCallId: "tc1" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("failed to start");
  });

  it("returns error when health check throws", async () => {
    const provider = mockProvider({
      health: vi.fn().mockRejectedValue(new Error("connection refused")),
    });
    const ctx = mockContext();

    const cap = sandboxCapability({ provider });
    const elevate = cap.tools!(ctx).find((t) => t.name === "elevate")!;

    const result = await elevate.execute({ reason: "test" }, { toolCallId: "tc1" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("connection refused");
  });
});

describe("Install detection", () => {
  it("triggers sync on npm install", async () => {
    const provider = mockProvider({
      triggerSync: vi.fn().mockResolvedValue(undefined),
    });
    const ctx = await mockElevatedContext();

    const cap = sandboxCapability({ provider });
    const exec = cap.tools!(ctx).find((t) => t.name === "exec")!;

    await exec.execute({ command: "npm install express" }, { toolCallId: "test" });
    expect(provider.triggerSync).toHaveBeenCalled();
  });

  it("triggers sync on bun add", async () => {
    const provider = mockProvider({
      triggerSync: vi.fn().mockResolvedValue(undefined),
    });
    const ctx = await mockElevatedContext();

    const cap = sandboxCapability({ provider });
    const exec = cap.tools!(ctx).find((t) => t.name === "exec")!;

    await exec.execute({ command: "bun add react" }, { toolCallId: "test" });
    expect(provider.triggerSync).toHaveBeenCalled();
  });

  it("does not trigger sync on non-install commands", async () => {
    const provider = mockProvider({
      triggerSync: vi.fn().mockResolvedValue(undefined),
    });
    const ctx = await mockElevatedContext();

    const cap = sandboxCapability({ provider });
    const exec = cap.tools!(ctx).find((t) => t.name === "exec")!;

    await exec.execute({ command: "ls -la" }, { toolCallId: "test" });
    expect(provider.triggerSync).not.toHaveBeenCalled();
  });

  it("does not trigger sync on failed install", async () => {
    const provider = mockProvider({
      exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "error", exitCode: 1 }),
      triggerSync: vi.fn().mockResolvedValue(undefined),
    });
    const ctx = await mockElevatedContext();

    const cap = sandboxCapability({ provider });
    const exec = cap.tools!(ctx).find((t) => t.name === "exec")!;

    await exec.execute({ command: "npm install nonexistent" }, { toolCallId: "test" });
    expect(provider.triggerSync).not.toHaveBeenCalled();
  });
});

describe("Auto-de-elevate", () => {
  it("stops running processes before de-elevating", async () => {
    const provider = mockProvider({
      processList: vi
        .fn()
        .mockResolvedValue([{ name: "dev", command: "npm start", running: true, pid: 42 }]),
    });
    const storage = createMapStorage();
    await setSessionElevated(storage, "s1", "reason");
    const ctx = mockContext(storage);

    const cap = sandboxCapability({ provider });
    const schedules = cap.schedules!(ctx);
    const timerConfig = schedules[0];

    await (timerConfig as any).callback({
      sessionStore: { list: () => [], appendEntry: vi.fn() },
      abortAllSessions: vi.fn(),
    });

    expect(provider.processStop).toHaveBeenCalledWith("dev");
    expect(provider.stop).toHaveBeenCalled();
  });

  it("broadcasts to all sessions", async () => {
    const provider = mockProvider();
    const storage = createMapStorage();
    await setSessionElevated(storage, "s1", "reason");
    const ctx = mockContext(storage);

    const cap = sandboxCapability({ provider });
    const schedules = cap.schedules!(ctx);
    const timerConfig = schedules[0];

    await (timerConfig as any).callback({
      sessionStore: { list: () => [], appendEntry: vi.fn() },
      abortAllSessions: vi.fn(),
    });

    expect(ctx.broadcastToAll).toHaveBeenCalledWith("sandbox_elevation", { elevated: false });
  });

  it("injects de-elevation notice only into elevated sessions", async () => {
    const provider = mockProvider();
    const storage = createMapStorage();
    await setSessionElevated(storage, "session-1", "reason");
    // session-2 is NOT elevated
    const ctx = mockContext(storage);
    const appendEntry = vi.fn();

    const cap = sandboxCapability({ provider });
    const schedules = cap.schedules!(ctx);
    const timerConfig = schedules[0];

    await (timerConfig as any).callback({
      sessionStore: {
        list: () => [{ id: "session-1" }, { id: "session-2" }],
        appendEntry,
      },
      abortAllSessions: vi.fn(),
    });

    // Notice should be injected into session-1 (was elevated) but NOT session-2
    expect(appendEntry).toHaveBeenCalledTimes(1);
    expect(appendEntry).toHaveBeenCalledWith("session-1", {
      type: "message",
      data: expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: expect.stringContaining("automatically deactivated") }],
      }),
    });
  });
});
