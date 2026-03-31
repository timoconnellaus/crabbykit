import type { CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import { isAnySessionElevated, setSessionElevated } from "../session-state.js";
import { cancelDeElevationTimer, resetDeElevationTimer, TIMER_ID } from "../timer.js";
import type { SandboxConfig, SandboxProvider } from "../types.js";

function mockProvider(): SandboxProvider {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue({ ready: true }),
    exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
  };
}

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

function mockContext(storage?: CapabilityStorage) {
  return {
    agentId: "test-agent",
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
    storage: storage ?? createMapStorage(),
  };
}

const config: Required<SandboxConfig> = {
  idleTimeout: 180,
  activeTimeout: 900,
  defaultCwd: "/mnt/r2",
  defaultExecTimeout: 60_000,
};

describe("TIMER_ID", () => {
  it("is sandbox:de-elevate", () => {
    expect(TIMER_ID).toBe("sandbox:de-elevate");
  });
});

describe("resetDeElevationTimer", () => {
  it("cancels existing timer and sets a new one", async () => {
    const ctx = mockContext();
    await resetDeElevationTimer(mockProvider(), config, ctx);

    expect(ctx.schedules.cancelTimer).toHaveBeenCalledWith(TIMER_ID);
    expect(ctx.schedules.setTimer).toHaveBeenCalledWith(TIMER_ID, 180, expect.any(Function));
  });

  it("uses custom timeout when provided", async () => {
    const ctx = mockContext();
    await resetDeElevationTimer(mockProvider(), config, ctx, 600);

    expect(ctx.schedules.setTimer).toHaveBeenCalledWith(TIMER_ID, 600, expect.any(Function));
  });

  it("uses config.idleTimeout when no custom timeout", async () => {
    const ctx = mockContext();
    const customConfig = { ...config, idleTimeout: 300 };
    await resetDeElevationTimer(mockProvider(), customConfig, ctx);

    expect(ctx.schedules.setTimer).toHaveBeenCalledWith(TIMER_ID, 300, expect.any(Function));
  });

  describe("timer callback", () => {
    it("stops provider and clears all session state when any elevated", async () => {
      const provider = mockProvider();
      const storage = createMapStorage();
      await setSessionElevated(storage, "s1", "reason-a");
      await setSessionElevated(storage, "s2", "reason-b");
      const ctx = mockContext(storage);

      await resetDeElevationTimer(provider, config, ctx);

      const callback = (ctx.schedules.setTimer as ReturnType<typeof vi.fn>).mock.calls[0][2];
      await callback();

      expect(provider.stop).toHaveBeenCalled();
      expect(await isAnySessionElevated(storage)).toBe(false);
      expect(ctx.broadcastToAll).toHaveBeenCalledWith("sandbox_elevation", { elevated: false });
    });

    it("no-ops when no sessions are elevated", async () => {
      const provider = mockProvider();
      const storage = createMapStorage();
      const ctx = mockContext(storage);

      await resetDeElevationTimer(provider, config, ctx);
      const callback = (ctx.schedules.setTimer as ReturnType<typeof vi.fn>).mock.calls[0][2];
      await callback();

      expect(provider.stop).not.toHaveBeenCalled();
    });

    it("handles provider.stop() failure gracefully", async () => {
      const provider = mockProvider();
      (provider.stop as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
      const storage = createMapStorage();
      await setSessionElevated(storage, "s1", "reason");
      const ctx = mockContext(storage);

      await resetDeElevationTimer(provider, config, ctx);
      const callback = (ctx.schedules.setTimer as ReturnType<typeof vi.fn>).mock.calls[0][2];

      // Should not throw
      await callback();

      // State should still be cleared even though stop failed
      expect(await isAnySessionElevated(storage)).toBe(false);
    });

    it("no-ops when storage is missing", async () => {
      const ctx = mockContext();
      const noStorageCtx = { ...ctx, storage: undefined };
      await resetDeElevationTimer(mockProvider(), config, noStorageCtx as never);
      const callback = (noStorageCtx.schedules.setTimer as ReturnType<typeof vi.fn>).mock
        .calls[0][2];

      // Should not throw
      await callback();
    });
  });
});

describe("cancelDeElevationTimer", () => {
  it("cancels the timer by TIMER_ID", async () => {
    const ctx = mockContext();
    await cancelDeElevationTimer(ctx);

    expect(ctx.schedules.cancelTimer).toHaveBeenCalledWith(TIMER_ID);
  });
});
