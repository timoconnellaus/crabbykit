import { describe, expect, it, vi } from "vitest";
import { cancelDeElevationTimer, resetDeElevationTimer, TIMER_ID } from "../timer.js";
import type { SandboxConfig } from "../types.js";

function mockContext() {
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
    storage: undefined,
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
  it("sets timer with delay, preserving existing callback", async () => {
    const ctx = mockContext();
    await resetDeElevationTimer(config, ctx);

    expect(ctx.schedules.setTimer).toHaveBeenCalledWith(TIMER_ID, 180);
    expect(ctx.schedules.cancelTimer).not.toHaveBeenCalled();
  });

  it("uses custom timeout when provided", async () => {
    const ctx = mockContext();
    await resetDeElevationTimer(config, ctx, 600);

    expect(ctx.schedules.setTimer).toHaveBeenCalledWith(TIMER_ID, 600);
  });

  it("uses config.idleTimeout when no custom timeout", async () => {
    const ctx = mockContext();
    const customConfig = { ...config, idleTimeout: 300 };
    await resetDeElevationTimer(customConfig, ctx);

    expect(ctx.schedules.setTimer).toHaveBeenCalledWith(TIMER_ID, 300);
  });
});

describe("cancelDeElevationTimer", () => {
  it("cancels the timer by TIMER_ID", async () => {
    const ctx = mockContext();
    await cancelDeElevationTimer(ctx);

    expect(ctx.schedules.cancelTimer).toHaveBeenCalledWith(TIMER_ID);
  });
});
