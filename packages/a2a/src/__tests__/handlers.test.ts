import { describe, expect, it, vi } from "vitest";
import type { CapabilityHttpContext, CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import { createCallbackHandler } from "../client/handlers.js";

// biome-ignore lint/suspicious/noExplicitAny: test helper
type R = any;

// ============================================================================
// Mock CapabilityStorage
// ============================================================================

function createMockStorage(): CapabilityStorage {
  const store = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => store.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      store.set(key, value);
    },
    delete: async (key: string) => store.delete(key),
    list: async <T>(prefix?: string) => {
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

function createMockContext(overrides?: Partial<CapabilityHttpContext>): CapabilityHttpContext {
  return {
    sendPrompt: vi.fn().mockResolvedValue({ sessionId: "s1", response: "ok" }),
    broadcastToAll: vi.fn(),
    broadcastState: vi.fn(),
    sessionStore: {} as R,
    ...overrides,
  } as unknown as CapabilityHttpContext;
}

// ============================================================================
// Tests
// ============================================================================

describe("createCallbackHandler", () => {
  it("returns a handler with POST /a2a-callback", () => {
    const storage = createMockStorage();
    const handler = createCallbackHandler(() => storage);

    expect(handler.method).toBe("POST");
    expect(handler.path).toBe("/a2a-callback");
  });

  it("returns 400 for invalid JSON", async () => {
    const storage = createMockStorage();
    const handler = createCallbackHandler(() => storage);
    const ctx = createMockContext();

    const request = new Request("https://test/a2a-callback", {
      method: "POST",
      body: "not json",
    });

    const response = await handler.handler(request, ctx);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect((body as R).error).toBe("Invalid JSON");
  });

  it("returns 400 for missing taskId", async () => {
    const storage = createMockStorage();
    const handler = createCallbackHandler(() => storage);
    const ctx = createMockContext();

    const request = new Request("https://test/a2a-callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: { state: "completed" } }),
    });

    const response = await handler.handler(request, ctx);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect((body as R).error).toBe("Missing taskId or status");
  });

  it("returns 400 for missing status", async () => {
    const storage = createMockStorage();
    const handler = createCallbackHandler(() => storage);
    const ctx = createMockContext();

    const request = new Request("https://test/a2a-callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: "t1" }),
    });

    const response = await handler.handler(request, ctx);
    expect(response.status).toBe(400);
  });

  it("returns 404 for unknown task", async () => {
    const storage = createMockStorage();
    const handler = createCallbackHandler(() => storage);
    const ctx = createMockContext();

    const request = new Request("https://test/a2a-callback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer token",
      },
      body: JSON.stringify({
        taskId: "unknown-task",
        status: { state: "completed", timestamp: "now" },
      }),
    });

    const response = await handler.handler(request, ctx);
    expect(response.status).toBe(404);

    const body = await response.json();
    expect((body as R).error).toBe("Unknown task");
  });

  it("returns 401 for invalid webhook token", async () => {
    const storage = createMockStorage();
    // Pre-populate a pending task
    await storage.put("task:t1", {
      taskId: "t1",
      contextId: "ctx-1",
      targetAgent: "agent-2",
      targetAgentName: "Agent Two",
      originalRequest: "Do something",
      state: "working",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
      originSessionId: "session-1",
      webhookToken: "correct-token",
    });

    const handler = createCallbackHandler(() => storage);
    const ctx = createMockContext();

    const request = new Request("https://test/a2a-callback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-token",
      },
      body: JSON.stringify({
        taskId: "t1",
        status: { state: "completed", timestamp: "now" },
      }),
    });

    const response = await handler.handler(request, ctx);
    expect(response.status).toBe(401);

    const body = await response.json();
    expect((body as R).error).toBe("Invalid webhook token");
  });

  it("returns 401 when no Authorization header", async () => {
    const storage = createMockStorage();
    await storage.put("task:t1", {
      taskId: "t1",
      contextId: "ctx-1",
      targetAgent: "agent-2",
      targetAgentName: "Agent Two",
      originalRequest: "Do something",
      state: "working",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
      originSessionId: "session-1",
      webhookToken: "token",
    });

    const handler = createCallbackHandler(() => storage);
    const ctx = createMockContext();

    const request = new Request("https://test/a2a-callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: "t1",
        status: { state: "completed", timestamp: "now" },
      }),
    });

    const response = await handler.handler(request, ctx);
    expect(response.status).toBe(401);
  });

  it("updates task state and sends prompt for terminal state", async () => {
    const storage = createMockStorage();
    await storage.put("task:t1", {
      taskId: "t1",
      contextId: "ctx-1",
      targetAgent: "agent-2",
      targetAgentName: "Agent Two",
      originalRequest: "Do something",
      state: "working",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
      originSessionId: "session-1",
      webhookToken: "secret",
    });

    const handler = createCallbackHandler(() => storage);
    const sendPrompt = vi.fn().mockResolvedValue({ sessionId: "session-1", response: "ok" });
    const broadcastToAll = vi.fn();
    const ctx = createMockContext({ sendPrompt, broadcastToAll });

    const request = new Request("https://test/a2a-callback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret",
      },
      body: JSON.stringify({
        taskId: "t1",
        contextId: "ctx-1",
        status: {
          state: "completed",
          timestamp: "2025-01-02T00:00:00Z",
          message: {
            messageId: "m1",
            role: "agent",
            parts: [{ text: "Done!" }],
          },
        },
      }),
    });

    const response = await handler.handler(request, ctx);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect((body as R).ok).toBe(true);

    // Should have called sendPrompt with result text
    expect(sendPrompt).toHaveBeenCalledOnce();
    const promptArgs = sendPrompt.mock.calls[0][0];
    expect(promptArgs.sessionId).toBe("session-1");
    expect(promptArgs.text).toContain("Agent Two");
    expect(promptArgs.text).toContain("Done!");
    expect(promptArgs.source).toBe("a2a-callback");

    // Should broadcast status update
    expect(broadcastToAll).toHaveBeenCalledOnce();
    expect(broadcastToAll.mock.calls[0][0]).toBe("a2a_task_update");

    // Task should be cleaned up (deleted)
    expect(await storage.get("task:t1")).toBeUndefined();
  });

  it("updates state but does not send prompt for non-terminal state", async () => {
    const storage = createMockStorage();
    await storage.put("task:t1", {
      taskId: "t1",
      contextId: "ctx-1",
      targetAgent: "agent-2",
      targetAgentName: "Agent Two",
      originalRequest: "Do something",
      state: "submitted",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
      originSessionId: "session-1",
      webhookToken: "secret",
    });

    const handler = createCallbackHandler(() => storage);
    const sendPrompt = vi.fn();
    const broadcastToAll = vi.fn();
    const ctx = createMockContext({ sendPrompt, broadcastToAll });

    const request = new Request("https://test/a2a-callback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret",
      },
      body: JSON.stringify({
        taskId: "t1",
        contextId: "ctx-1",
        status: { state: "working", timestamp: "2025-01-02T00:00:00Z" },
      }),
    });

    const response = await handler.handler(request, ctx);
    expect(response.status).toBe(200);

    // Should NOT send prompt for non-terminal state
    expect(sendPrompt).not.toHaveBeenCalled();

    // Should still broadcast
    expect(broadcastToAll).toHaveBeenCalledOnce();

    // Task should still exist
    expect(await storage.get("task:t1")).toBeDefined();
  });

  it("handles failed task result format", async () => {
    const storage = createMockStorage();
    await storage.put("task:t1", {
      taskId: "t1",
      contextId: "ctx-1",
      targetAgent: "agent-2",
      targetAgentName: "Agent Two",
      originalRequest: "Do something",
      state: "working",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
      originSessionId: "session-1",
      webhookToken: "secret",
    });

    const handler = createCallbackHandler(() => storage);
    const sendPrompt = vi.fn().mockResolvedValue({ sessionId: "s1", response: "ok" });
    const ctx = createMockContext({ sendPrompt });

    const request = new Request("https://test/a2a-callback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret",
      },
      body: JSON.stringify({
        taskId: "t1",
        contextId: "ctx-1",
        status: {
          state: "failed",
          timestamp: "now",
          message: {
            messageId: "m1",
            role: "agent",
            parts: [{ text: "Something went wrong" }],
          },
        },
      }),
    });

    await handler.handler(request, ctx);

    const promptText = sendPrompt.mock.calls[0][0].text;
    expect(promptText).toContain("A2A Task Failed");
    expect(promptText).toContain("Something went wrong");
  });

  it("handles sendPrompt failure gracefully", async () => {
    const storage = createMockStorage();
    await storage.put("task:t1", {
      taskId: "t1",
      contextId: "ctx-1",
      targetAgent: "agent-2",
      targetAgentName: "Agent Two",
      originalRequest: "Do something",
      state: "working",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
      originSessionId: "session-1",
      webhookToken: "secret",
    });

    const handler = createCallbackHandler(() => storage);
    const sendPrompt = vi.fn().mockRejectedValue(new Error("Session busy"));
    const ctx = createMockContext({ sendPrompt });

    const request = new Request("https://test/a2a-callback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret",
      },
      body: JSON.stringify({
        taskId: "t1",
        contextId: "ctx-1",
        status: { state: "completed", timestamp: "now" },
      }),
    });

    // Should not throw — error is caught silently
    const response = await handler.handler(request, ctx);
    expect(response.status).toBe(200);
  });
});
