import { createMockStorage } from "@claw-for-cloudflare/agent-runtime/test-utils";
import { describe, expect, it, vi } from "vitest";
import { doomLoopDetection } from "../capability.js";
import type { CapabilityHookContext, BeforeToolExecutionEvent } from "@claw-for-cloudflare/agent-runtime";

function makeEvent(toolName: string, args: unknown = {}): BeforeToolExecutionEvent {
  return { toolName, args, toolCallId: `call-${Date.now()}` };
}

function makeCtx(overrides: Partial<CapabilityHookContext> = {}): CapabilityHookContext {
  return {
    agentId: "test-agent",
    sessionId: "s1",
    sessionStore: {} as CapabilityHookContext["sessionStore"],
    storage: createMockStorage(),
    broadcast: vi.fn(),
    ...overrides,
  };
}

describe("doomLoopDetection", () => {
  describe("capability shape", () => {
    it("returns a valid Capability with correct id and hooks", () => {
      const cap = doomLoopDetection();
      expect(cap.id).toBe("doom-loop-detection");
      expect(cap.name).toBe("Doom Loop Detection");
      expect(cap.hooks?.beforeToolExecution).toBeInstanceOf(Function);
    });

    it("has config schema with threshold and lookbackWindow", () => {
      const cap = doomLoopDetection();
      expect(cap.configSchema).toBeDefined();
      expect(cap.configDefault).toEqual({ threshold: 3, lookbackWindow: 10 });
    });
  });

  describe("happy path — blocks at threshold", () => {
    it("blocks after 3 consecutive identical calls (default threshold)", async () => {
      const cap = doomLoopDetection();
      const hook = cap.hooks!.beforeToolExecution!;
      const ctx = makeCtx();
      const event = makeEvent("search", { query: "test" });

      // First 2 calls should pass
      expect(await hook(event, ctx)).toBeUndefined();
      expect(await hook(event, ctx)).toBeUndefined();

      // 3rd call should block
      const result = await hook(event, ctx);
      expect(result).toEqual({
        block: true,
        reason: expect.stringContaining("Doom loop detected"),
      });
      expect(result!.reason).toContain("search");
      expect(result!.reason).toContain("3 times");
    });

    it("includes tool name and count in the block reason", async () => {
      const cap = doomLoopDetection({ threshold: 2 });
      const hook = cap.hooks!.beforeToolExecution!;
      const ctx = makeCtx();
      const event = makeEvent("my_tool", { x: 1 });

      await hook(event, ctx);
      const result = await hook(event, ctx);
      expect(result!.reason).toContain("my_tool");
      expect(result!.reason).toContain("2 times");
    });
  });

  describe("negative — different args not flagged", () => {
    it("does not block when same tool is called with different arguments", async () => {
      const cap = doomLoopDetection();
      const hook = cap.hooks!.beforeToolExecution!;
      const ctx = makeCtx();

      expect(await hook(makeEvent("search", { query: "a" }), ctx)).toBeUndefined();
      expect(await hook(makeEvent("search", { query: "b" }), ctx)).toBeUndefined();
      expect(await hook(makeEvent("search", { query: "c" }), ctx)).toBeUndefined();
      // No block because args differ each time
    });

    it("does not block when calls are interleaved with other tools", async () => {
      const cap = doomLoopDetection();
      const hook = cap.hooks!.beforeToolExecution!;
      const ctx = makeCtx();
      const eventA = makeEvent("search", { query: "test" });
      const eventB = makeEvent("fetch", { url: "https://x.com" });

      await hook(eventA, ctx);
      await hook(eventB, ctx); // breaks the streak
      await hook(eventA, ctx);
      // Not blocked — streak was broken
    });
  });

  describe("boundary conditions", () => {
    it("blocks immediately with threshold of 1", async () => {
      const cap = doomLoopDetection({ threshold: 1 });
      const hook = cap.hooks!.beforeToolExecution!;
      const ctx = makeCtx();

      const result = await hook(makeEvent("search", {}), ctx);
      expect(result).toEqual({
        block: true,
        reason: expect.stringContaining("1 times"),
      });
    });

    it("handles empty args (undefined/null)", async () => {
      const cap = doomLoopDetection({ threshold: 2 });
      const hook = cap.hooks!.beforeToolExecution!;
      const ctx = makeCtx();

      await hook(makeEvent("tool", undefined), ctx);
      const result = await hook(makeEvent("tool", undefined), ctx);
      expect(result?.block).toBe(true);
    });

    it("handles empty object args", async () => {
      const cap = doomLoopDetection({ threshold: 2 });
      const hook = cap.hooks!.beforeToolExecution!;
      const ctx = makeCtx();

      await hook(makeEvent("tool", {}), ctx);
      const result = await hook(makeEvent("tool", {}), ctx);
      expect(result?.block).toBe(true);
    });

    it("treats args with different key order as identical", async () => {
      const cap = doomLoopDetection({ threshold: 2 });
      const hook = cap.hooks!.beforeToolExecution!;
      const ctx = makeCtx();

      await hook(makeEvent("tool", { a: 1, b: 2 }), ctx);
      const result = await hook(makeEvent("tool", { b: 2, a: 1 }), ctx);
      expect(result?.block).toBe(true);
    });

    it("does not block with lookbackWindow of 0 (effectively disabled)", async () => {
      const cap = doomLoopDetection({ lookbackWindow: 0 });
      const hook = cap.hooks!.beforeToolExecution!;
      const ctx = makeCtx();
      const event = makeEvent("search", {});

      // With lookback 0, the ring buffer is always empty so no history is kept
      expect(await hook(event, ctx)).toBeUndefined();
      expect(await hook(event, ctx)).toBeUndefined();
      expect(await hook(event, ctx)).toBeUndefined();
    });
  });

  describe("state transitions", () => {
    it("resets counter when a different tool breaks the streak", async () => {
      const cap = doomLoopDetection();
      const hook = cap.hooks!.beforeToolExecution!;
      const ctx = makeCtx();
      const event = makeEvent("search", { q: "x" });

      await hook(event, ctx);
      await hook(event, ctx);
      // 2 consecutive — break the streak
      await hook(makeEvent("other_tool", {}), ctx);
      // Restart counting
      expect(await hook(event, ctx)).toBeUndefined();
      expect(await hook(event, ctx)).toBeUndefined();
      // Now 2 again, still not at threshold 3
    });

    it("continues blocking after threshold is reached", async () => {
      const cap = doomLoopDetection({ threshold: 2 });
      const hook = cap.hooks!.beforeToolExecution!;
      const ctx = makeCtx();
      const event = makeEvent("search", {});

      await hook(event, ctx);
      expect((await hook(event, ctx))?.block).toBe(true); // 2nd
      expect((await hook(event, ctx))?.block).toBe(true); // 3rd — still blocked
      expect((await hook(event, ctx))?.block).toBe(true); // 4th — still blocked
    });
  });

  describe("invariants", () => {
    it("allowRepeat tools are never blocked regardless of repetitions", async () => {
      const cap = doomLoopDetection({
        threshold: 2,
        allowRepeatTools: ["poll_status"],
      });
      const hook = cap.hooks!.beforeToolExecution!;
      const ctx = makeCtx();
      const event = makeEvent("poll_status", { id: "123" });

      // Call many times — should never block
      for (let i = 0; i < 10; i++) {
        expect(await hook(event, ctx)).toBeUndefined();
      }
    });

    it("allowRepeat tool calls do not affect detection for other tools", async () => {
      const cap = doomLoopDetection({
        threshold: 3,
        allowRepeatTools: ["poll_status"],
      });
      const hook = cap.hooks!.beforeToolExecution!;
      const ctx = makeCtx();

      // Two calls to search, then an allowed repeat tool, then search again
      await hook(makeEvent("search", { q: "x" }), ctx);
      await hook(makeEvent("search", { q: "x" }), ctx);
      await hook(makeEvent("poll_status", {}), ctx);
      // poll_status breaks the consecutive streak for search
      expect(await hook(makeEvent("search", { q: "x" }), ctx)).toBeUndefined();
    });

    it("broadcasts doom_loop_detected event when blocking", async () => {
      const cap = doomLoopDetection({ threshold: 2 });
      const hook = cap.hooks!.beforeToolExecution!;
      const broadcast = vi.fn();
      const ctx = makeCtx({ broadcast });
      const event = makeEvent("search", {});

      await hook(event, ctx);
      await hook(event, ctx);

      expect(broadcast).toHaveBeenCalledWith(
        "doom_loop_detected",
        { toolName: "search", count: 2 },
      );
    });

    it("does not broadcast when calls are within threshold", async () => {
      const cap = doomLoopDetection();
      const hook = cap.hooks!.beforeToolExecution!;
      const broadcast = vi.fn();
      const ctx = makeCtx({ broadcast });

      await hook(makeEvent("search", {}), ctx);
      await hook(makeEvent("search", {}), ctx);
      // Only 2 calls, threshold is 3
      expect(broadcast).not.toHaveBeenCalled();
    });

    it("uses separate storage per ctx (no cross-session bleed)", async () => {
      const cap = doomLoopDetection({ threshold: 2 });
      const hook = cap.hooks!.beforeToolExecution!;
      const ctx1 = makeCtx();
      const ctx2 = makeCtx();
      const event = makeEvent("search", {});

      await hook(event, ctx1);
      // ctx2 has separate storage — no bleed
      expect(await hook(event, ctx2)).toBeUndefined();
    });
  });

  describe("custom threshold", () => {
    it("respects threshold of 5", async () => {
      const cap = doomLoopDetection({ threshold: 5 });
      const hook = cap.hooks!.beforeToolExecution!;
      const ctx = makeCtx();
      const event = makeEvent("search", {});

      for (let i = 0; i < 4; i++) {
        expect(await hook(event, ctx)).toBeUndefined();
      }
      const result = await hook(event, ctx);
      expect(result?.block).toBe(true);
      expect(result?.reason).toContain("5 times");
    });
  });
});
