import type { AgentContext } from "@claw-for-cloudflare/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import { sandboxCapability } from "../capability.js";
import { clearTeardownPromise, getTeardownPromise, setTeardownPromise } from "../teardown.js";
import type { SandboxProvider } from "../types.js";

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
      get: vi.fn().mockImplementation((key: string) => {
        if (key === "elevated") return Promise.resolve(elevated);
        return Promise.resolve(undefined);
      }),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(false),
      list: vi.fn().mockResolvedValue(new Map()),
    },
  };
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
    const ctx = mockContext(false);

    let resolveTeardown: () => void;
    const teardown = new Promise<void>((r) => {
      resolveTeardown = r;
    });
    setTeardownPromise(teardown);

    const cap = sandboxCapability({ provider });
    const elevate = cap.tools!(ctx).find((t) => t.name === "elevate")!;

    // Start elevate (it should wait for teardown)
    let elevateFinished = false;
    const elevatePromise = elevate.execute("tc1", { reason: "test" }).then(() => {
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
    const ctx = mockContext(false);

    const cap = sandboxCapability({ provider });
    const elevate = cap.tools!(ctx).find((t) => t.name === "elevate")!;

    const result = await elevate.execute("tc1", { reason: "test" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("failed to start");
    // Should not mark as elevated
    expect(ctx.storage!.put).not.toHaveBeenCalledWith("elevated", true);
  });

  it("returns error when health check throws", async () => {
    const provider = mockProvider({
      health: vi.fn().mockRejectedValue(new Error("connection refused")),
    });
    const ctx = mockContext(false);

    const cap = sandboxCapability({ provider });
    const elevate = cap.tools!(ctx).find((t) => t.name === "elevate")!;

    const result = await elevate.execute("tc1", { reason: "test" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("connection refused");
  });
});

describe("Install detection", () => {
  it("triggers sync on npm install", async () => {
    const provider = mockProvider({
      triggerSync: vi.fn().mockResolvedValue(undefined),
    });
    const ctx = mockContext(true);

    const cap = sandboxCapability({ provider });
    const bash = cap.tools!(ctx).find((t) => t.name === "bash")!;

    await bash.execute("tc1", { command: "npm install express" });
    expect(provider.triggerSync).toHaveBeenCalled();
  });

  it("triggers sync on bun add", async () => {
    const provider = mockProvider({
      triggerSync: vi.fn().mockResolvedValue(undefined),
    });
    const ctx = mockContext(true);

    const cap = sandboxCapability({ provider });
    const bash = cap.tools!(ctx).find((t) => t.name === "bash")!;

    await bash.execute("tc1", { command: "bun add react" });
    expect(provider.triggerSync).toHaveBeenCalled();
  });

  it("does not trigger sync on non-install commands", async () => {
    const provider = mockProvider({
      triggerSync: vi.fn().mockResolvedValue(undefined),
    });
    const ctx = mockContext(true);

    const cap = sandboxCapability({ provider });
    const bash = cap.tools!(ctx).find((t) => t.name === "bash")!;

    await bash.execute("tc1", { command: "ls -la" });
    expect(provider.triggerSync).not.toHaveBeenCalled();
  });

  it("does not trigger sync on failed install", async () => {
    const provider = mockProvider({
      exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "error", exitCode: 1 }),
      triggerSync: vi.fn().mockResolvedValue(undefined),
    });
    const ctx = mockContext(true);

    const cap = sandboxCapability({ provider });
    const bash = cap.tools!(ctx).find((t) => t.name === "bash")!;

    await bash.execute("tc1", { command: "npm install nonexistent" });
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
    const ctx = mockContext(true);

    const cap = sandboxCapability({ provider });
    const schedules = cap.schedules!(ctx);
    const timerConfig = schedules[0];

    // Call the timer callback directly
    await (timerConfig as any).callback({ sessionStore: { list: () => [], appendEntry: vi.fn() } });

    expect(provider.processStop).toHaveBeenCalledWith("dev");
    expect(provider.stop).toHaveBeenCalled();
  });

  it("broadcasts to all sessions", async () => {
    const provider = mockProvider();
    const ctx = mockContext(true);

    const cap = sandboxCapability({ provider });
    const schedules = cap.schedules!(ctx);
    const timerConfig = schedules[0];

    await (timerConfig as any).callback({ sessionStore: { list: () => [], appendEntry: vi.fn() } });

    expect(ctx.broadcastToAll).toHaveBeenCalledWith("sandbox_elevation", { elevated: false });
  });
});
