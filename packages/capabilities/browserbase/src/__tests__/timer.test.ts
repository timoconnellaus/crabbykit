import type { AgentContext } from "@crabbykit/agent-runtime";
import { createNoopStorage } from "@crabbykit/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import { cancelTimers, idleTimerId, maxTimerId, resetIdleTimer, setMaxTimer } from "../timer.js";

function mockContext(): AgentContext {
  return {
    agentId: "agent-1",
    sessionId: "session-1",
    stepNumber: 1,
    emitCost: vi.fn(),
    broadcast: vi.fn(),
    broadcastToAll: vi.fn(),
    broadcastState: vi.fn(),
    requestFromClient: vi.fn(),
    schedules: {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      get: vi.fn(),
      setTimer: vi.fn(),
      cancelTimer: vi.fn(),
    },
    storage: createNoopStorage(),
    rateLimit: { consume: async () => ({ allowed: true }) },
    notifyBundlePointerChanged: async () => {},
  };
}

describe("timer IDs", () => {
  it("idleTimerId includes session ID", () => {
    expect(idleTimerId("sess-abc")).toBe("browserbase:idle:sess-abc");
  });

  it("maxTimerId includes session ID", () => {
    expect(maxTimerId("sess-abc")).toBe("browserbase:max:sess-abc");
  });
});

describe("resetIdleTimer", () => {
  it("calls setTimer with correct ID and delay", async () => {
    const ctx = mockContext();
    await resetIdleTimer("sess-1", ctx, 300);

    expect(ctx.schedules.setTimer).toHaveBeenCalledWith("browserbase:idle:sess-1", 300, undefined);
  });

  it("passes callback on first call", async () => {
    const ctx = mockContext();
    const cb = vi.fn();
    await resetIdleTimer("sess-1", ctx, 300, cb);

    expect(ctx.schedules.setTimer).toHaveBeenCalledWith("browserbase:idle:sess-1", 300, cb);
  });
});

describe("setMaxTimer", () => {
  it("calls setTimer with correct ID, delay, and callback", async () => {
    const ctx = mockContext();
    const cb = vi.fn();
    await setMaxTimer("sess-1", ctx, 1800, cb);

    expect(ctx.schedules.setTimer).toHaveBeenCalledWith("browserbase:max:sess-1", 1800, cb);
  });
});

describe("cancelTimers", () => {
  it("cancels both idle and max timers", async () => {
    const ctx = mockContext();
    await cancelTimers("sess-1", ctx);

    expect(ctx.schedules.cancelTimer).toHaveBeenCalledWith("browserbase:idle:sess-1");
    expect(ctx.schedules.cancelTimer).toHaveBeenCalledWith("browserbase:max:sess-1");
  });
});
