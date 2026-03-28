import { describe, expect, it, vi } from "vitest";
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

function mockContext() {
  return {
    sessionId: "s1",
    stepNumber: 0,
    emitCost: () => {},
    broadcast: vi.fn(),
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
    it("stops provider and clears state when elevated", async () => {
      const provider = mockProvider();
      const ctx = mockContext();
      (ctx.storage.get as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      await resetDeElevationTimer(provider, config, ctx);

      // Extract and invoke the callback
      const callback = (ctx.schedules.setTimer as ReturnType<typeof vi.fn>).mock.calls[0][2];
      await callback();

      expect(provider.stop).toHaveBeenCalled();
      expect(ctx.storage.put).toHaveBeenCalledWith("elevated", false);
      expect(ctx.storage.delete).toHaveBeenCalledWith("elevationReason");
      expect(ctx.storage.delete).toHaveBeenCalledWith("elevatedAt");
      expect(ctx.broadcast).toHaveBeenCalledWith("sandbox_elevation", { elevated: false });
    });

    it("no-ops when not elevated", async () => {
      const provider = mockProvider();
      const ctx = mockContext();
      (ctx.storage.get as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      await resetDeElevationTimer(provider, config, ctx);
      const callback = (ctx.schedules.setTimer as ReturnType<typeof vi.fn>).mock.calls[0][2];
      await callback();

      expect(provider.stop).not.toHaveBeenCalled();
      expect(ctx.storage.put).not.toHaveBeenCalled();
    });

    it("handles provider.stop() failure gracefully", async () => {
      const provider = mockProvider();
      (provider.stop as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
      const ctx = mockContext();
      (ctx.storage.get as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      await resetDeElevationTimer(provider, config, ctx);
      const callback = (ctx.schedules.setTimer as ReturnType<typeof vi.fn>).mock.calls[0][2];

      // Should not throw
      await callback();

      // State should still be cleared even though stop failed
      expect(ctx.storage.put).toHaveBeenCalledWith("elevated", false);
    });

    it("no-ops when storage is missing", async () => {
      const ctx = mockContext();
      const noStorageCtx = { ...ctx, storage: undefined };
      await resetDeElevationTimer(mockProvider(), config, noStorageCtx as any);
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
